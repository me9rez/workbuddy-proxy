/**
 * OpenAI-compatible HTTP surface.
 *
 *   GET  /health              → { ok, activeId, account }
 *   GET  /v1/accounts         → the stored accounts (never their tokens)
 *   GET  /v1/models           → OpenAI model list (+ context_length / capabilities)
 *   POST /v1/chat/completions → chat completion (streaming passthrough or locally
 *                               aggregated non-streaming)
 *
 * Which account answers a request:
 *   1. `X-WorkBuddy-Account: <id|label|index>` header, or `?account=` query
 *   2. otherwise the store's active account
 * With `--fallback`, a failing account falls through to the remaining ones in order.
 *
 * Upstream only speaks streaming, so the proxy always requests `stream: true` and folds
 * the SSE back into one completion when the client did not ask for a stream.
 */

import http from 'node:http';
import { CHAT_URL, DEFAULT_HOST, DEFAULT_PORT } from './constants.js';
import { credentialHeaders, WorkBuddyError } from './api.js';
import { aggregateSse } from './sse.js';
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
 * Build the request handler. Exported separately from `startServer` so tests can drive it
 * without binding a port.
 */
export function createHandler({ localToken = '', logger = console, allowFallthrough = false } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (localToken && bearerToken(req.headers.authorization) !== localToken) {
        return sendJson(res, 401, { error: { message: 'invalid local token', type: 'invalid_request_error' } });
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
        return await handleChat(req, res, url, { logger, allowFallthrough });
      }

      return sendJson(res, 404, { error: { message: `no route: ${req.method} ${url.pathname}` } });
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

async function handleChat(req, res, url, { logger, allowFallthrough }) {
  const session = await resolveSession(req, url, { allowFallthrough });
  const raw = await readBody(req);

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
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
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-workbuddy-account': session.id,
    });
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    return res.end();
  }

  return sendJson(res, 200, aggregateSse(await upstream.text(), payload.model));
}

/** Start listening. @returns {import('node:http').Server} */
export function startServer({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  localToken = '',
  logger = console,
  allowFallthrough = false,
} = {}) {
  const server = http.createServer(createHandler({ localToken, logger, allowFallthrough }));
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
    logger.log?.(`workbuddy-proxy listening on http://${shown}:${port}`);
    logger.log?.(`  OpenAI base URL: http://${shown}:${port}/v1`);
    logger.log?.(`  models:          http://${shown}:${port}/v1/models`);
    logger.log?.(`  accounts:        http://${shown}:${port}/v1/accounts`);
    if (localToken) logger.log?.('  local bearer token: required');
  });
  return server;
}
