/**
 * OpenAI 兼容的 HTTP 层。
 *
 *   GET  /health              → { ok, activeId, account, accounts }
 *   GET  /v1/accounts         → 已保存的账号(不含令牌)
 *   GET  /v1/models           → OpenAI 模型列表(附 context_length / capabilities)
 *   POST /v1/chat/completions → 对话补全(流式透传,或本地聚合为非流式)
 *
 * 用哪个账号应答:
 *   1. `X-WorkBuddy-Account: <id|名称|序号>` header,或 `?account=` query
 *   2. 都没有则用存储中的当前账号
 * 加 `--fallback` 时,某个账号失败会按顺序尝试其余账号。
 *
 * 上游只支持流式,所以代理一律以 `stream: true` 请求,并在客户端要非流式时
 * 把 SSE 折回一个完整响应。
 *
 * 两个可选的安全网,**默认都关闭**,需要显式开启:
 *   - **心跳**(`serve --heartbeat <秒>`):空闲时定期写 SSE 注释行,避免长时间无数据被超时断开;
 *   - **断流检测**(`serve --detect-truncation`):上游中途断线、或流结束缺少结束标记时,
 *     往流里补一个 `{"error": …}` 事件,而不是让客户端把截断的输出当成正常结束。
 */

import http from 'node:http';
import { once } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { CHAT_URL, DEFAULT_HOST, DEFAULT_PORT, HEARTBEAT_INTERVAL_MS } from './constants.js';
import { credentialHeaders, WorkBuddyError } from './api.js';
import { SSE_HEARTBEAT, aggregateSse, formatSseError, sseLooksComplete } from './sse.js';
import { ensureFreshSession, listAccounts, loadStore, sessionSummary } from './session.js';
import { fetchModels, sessionCredential } from './catalog.js';

/** Read a request body as a UTF-8 string. */
export function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new WorkBuddyError(`请求体超过 ${limitBytes} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Send a JSON response. */
export function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Extract a bearer token from an Authorization header. */
export function bearerToken(headerValue) {
  const match = /^Bearer\s+(.+)$/i.exec(String(headerValue ?? '').trim());
  return match ? match[1].trim() : '';
}

/**
 * 常量时间比较两个 API Key,避免通过响应耗时逐字符猜测。
 * 长度不同直接返回 false(长度本身不是秘密)。
 */
export function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * HTTP header values are latin-1 by spec, so a client sending a UTF-8 label (a Chinese
 * account nickname, say) arrives as mojibake. Re-decode those bytes as UTF-8 when the
 * result is valid; otherwise keep the original text.
 */
export function decodeHeaderValue(value) {
  const text = String(value ?? '');
  if (!/[^\x00-\x7f]/.test(text)) return text;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'latin1'));
  } catch {
    return text;
  }
}

/** Which account this request asked for (header wins over query); '' = active account. */
export function requestedAccount(req, url) {
  const header = decodeHeaderValue(req.headers['x-workbuddy-account']).trim();
  if (header) return header;
  const query = url.searchParams.get('account');
  return query ? query.trim() : '';
}

/**
 * 开始给响应写 SSE 心跳注释行。
 *
 * 注释行(`:` 开头)按 SSE 规范会被客户端忽略,所以既能保活又不会污染数据流。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} intervalMs 间隔;<=0 表示关闭
 * @returns {() => void} 停止函数
 */
export function startHeartbeat(res, intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(SSE_HEARTBEAT);
    } catch {
      /* 连接已断开,下一次检查会停掉定时器 */
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * 把上游的 SSE 流透传给客户端,并处理背压;可选地加心跳与断流检测。
 *
 * @param {object} options
 * @param {number} [options.heartbeatMs]      心跳间隔;<=0(默认)关闭
 * @param {boolean} [options.detectTruncation] 断流时补发错误事件;默认关闭
 * @returns {Promise<void>}
 */
export async function pipeUpstreamStream(
  upstream,
  res,
  { heartbeatMs = 0, detectTruncation = false, logger = console } = {},
) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const stopHeartbeat = startHeartbeat(res, heartbeatMs);
  const decoder = new TextDecoder('utf-8');
  let tail = '';
  let failure = null;

  try {
    if (!upstream.body) {
      failure = '上游没有返回响应体';
    } else {
      for await (const chunk of upstream.body) {
        if (detectTruncation) {
          const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
          // 只保留尾部:跨 chunk 的结束标记检测不需要全文,避免无界增长。
          tail = (tail + text).slice(-4096);
        }
        if (!res.write(chunk)) await once(res, 'drain');
        if (res.destroyed) break;
      }
    }
  } catch (error) {
    failure = `上游流中断:${error?.message ?? error}`;
  } finally {
    stopHeartbeat();
  }

  // 默认是纯透传:既不补错误事件,也不改结束方式。
  if (!detectTruncation || res.destroyed || res.writableEnded) return res.end?.() ?? undefined;

  if (failure) {
    logger.error?.(`[proxy] ${failure}`);
    res.write(formatSseError(failure));
  } else if (!sseLooksComplete(tail)) {
    const message = '上游流提前结束(未收到结束标记 [DONE])';
    logger.error?.(`[proxy] ${message}`);
    res.write(formatSseError(message));
  }
  return res.end();
}

/**
 * Build the request handler. Exported separately from `startServer` so tests can drive it
 * without binding a port.
 */
export function createHandler({
  localToken = '',
  logger = console,
  allowFallthrough = false,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  detectTruncation = false,
} = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      // 免鉴权的最小存活探测:只回 ok,不泄露账号信息,方便监控与隧道健康检查。
      if (url.pathname === '/healthz' || url.pathname === '/ping') {
        return sendJson(res, 200, { ok: true });
      }

      if (localToken && !tokensMatch(bearerToken(req.headers.authorization), localToken)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="workbuddy-proxy"');
        return sendJson(res, 401, { error: { message: '本地令牌无效', type: 'invalid_request_error' } });
      }

      if (url.pathname === '/health') {
        const store = loadStore();
        const active = store.sessions.find((session) => session.id === store.activeId) ?? store.sessions[0] ?? null;
        return sendJson(res, 200, {
          ok: store.sessions.length > 0,
          activeId: store.activeId,
          account: sessionSummary(active)?.account ?? null,
          accounts: store.sessions.length,
        });
      }

      if (url.pathname === '/v1/accounts' && req.method === 'GET') {
        const store = loadStore();
        return sendJson(res, 200, { object: 'list', activeId: store.activeId, data: listAccounts(store) });
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const session = await resolveSession(req, url, { allowFallthrough });
        const models = await fetchModels(sessionCredential(session), {
          force: url.searchParams.get('refresh') === '1',
        });
        return sendJson(res, 200, {
          object: 'list',
          data: models.map((model) => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'workbuddy',
            name: model.name,
            context_length: model.contextWindow,
            max_output_tokens: model.maxTokens,
            capabilities: {
              vision: model.images,
              reasoning: model.reasoning,
              only_reasoning: model.onlyReasoning,
            },
          })),
        });
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        return await handleChat(req, res, url, { logger, allowFallthrough, heartbeatMs, detectTruncation });
      }

      return sendJson(res, 404, { error: { message: `未知路由:${req.method} ${url.pathname}` } });
    } catch (error) {
      const message = error?.message ?? String(error);
      logger.error?.(`[proxy] ${message}`);
      return sendJson(res, error instanceof WorkBuddyError && error.status ? error.status : 500, {
        error: { message, type: 'proxy_error' },
      });
    }
  };
}

/** Resolve the session this request must use, refreshing its token when needed. */
function resolveSession(req, url, { allowFallthrough }) {
  return ensureFreshSession({
    account: requestedAccount(req, url),
    fallthrough: allowFallthrough,
  });
}

async function handleChat(req, res, url, { logger, allowFallthrough, heartbeatMs, detectTruncation }) {
  const session = await resolveSession(req, url, { allowFallthrough });
  const raw = await readBody(req);

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: { message: '请求体不是合法的 JSON', type: 'invalid_request_error' } });
  }

  const wantsStream = payload.stream === true;
  const upstreamPayload = {
    ...payload,
    stream: true, // WorkBuddy rejects non-stream requests (code 11101)
    stream_options: { include_usage: true, ...(payload.stream_options ?? {}) },
  };

  let upstream;
  try {
    upstream = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        ...credentialHeaders(sessionCredential(session), { json: false }),
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(upstreamPayload),
    });
  } catch (cause) {
    throw new WorkBuddyError(`无法连接推理接口（${cause?.message ?? cause}）`, { cause });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return sendJson(res, upstream.status, {
      error: { message: `WorkBuddy HTTP ${upstream.status}`, detail: detail.slice(0, 800) },
    });
  }

  if (wantsStream) {
    return pipeUpstreamStream(upstream, res, { heartbeatMs, detectTruncation, logger });
  }

  // 非流式:读完整段 SSE 后本地聚合。上游中途断线时 upstream.text() 会抛错;
  // 开启 --detect-truncation 时,没有结束标记也视为截断 —— 两种都直接报错,
  // 不返回残缺的 completion。
  let sseText;
  try {
    sseText = await upstream.text();
  } catch (cause) {
    throw new WorkBuddyError(`读取上游响应失败（${cause?.message ?? cause}）`, { cause });
  }
  if (detectTruncation && !sseLooksComplete(sseText)) {
    throw new WorkBuddyError('上游流提前结束(未收到结束标记 [DONE])');
  }
  return sendJson(res, 200, aggregateSse(sseText, payload.model));
}

/** Start listening. @returns {import('node:http').Server} */
export function startServer({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  localToken = '',
  logger = console,
  allowFallthrough = false,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  detectTruncation = false,
} = {}) {
  const server = http.createServer(
    createHandler({ localToken, logger, allowFallthrough, heartbeatMs, detectTruncation }),
  );
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
    logger.log?.(`workbuddy-proxy 已启动:http://${shown}:${port}`);
    logger.log?.(`  OpenAI 兼容地址:http://${shown}:${port}/v1`);
    logger.log?.(`  模型列表:      http://${shown}:${port}/v1/models`);
    logger.log?.(`  账号列表:      http://${shown}:${port}/v1/accounts`);
    logger.log?.(`  SSE 心跳:      ${heartbeatMs > 0 ? `${heartbeatMs} ms` : '已关闭(默认)'}`);
    logger.log?.(`  断流检测:      ${detectTruncation ? '开启' : '已关闭(默认)'}`);
    if (localToken) logger.log?.('  本地令牌:      已启用,请求须带 Authorization: Bearer <key>');
  });
  return server;
}
