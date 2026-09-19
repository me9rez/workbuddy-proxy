/**
 * Server-Sent Events 处理。
 *
 * WorkBuddy **只**接受流式对话请求(非流式会被拒,`code 11101`,
 * "Non-stream chat request is currently not supported"),所以代理总是向上游要流;
 * 客户端要非流式响应时,用 `aggregateSse` 把流折回一个 `chat.completion`。
 */

/** Iterate the `data:` payloads of an SSE text blob, skipping `[DONE]`. */
export function* iterSseData(sseText) {
  for (const line of String(sseText).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue; // a malformed chunk must not kill the whole response
    }
    yield parsed;
  }
}

/** SSE 注释行 —— 按规范,客户端会忽略以 `:` 开头的行,因而适合做心跳保活。 */
export const SSE_HEARTBEAT = ': keep-alive\n\n';

/** 上游流的结束标记。 */
export const SSE_DONE = '[DONE]';

/**
 * 判断一段 SSE 文本里是否出现了结束标记。
 * 容忍 `data:[DONE]` / `data: [DONE]` 两种写法与前后空白。
 */
export function sseHasDone(text) {
  return /(?:^|\n)\s*data:\s*\[DONE\]/.test(String(text));
}

/**
 * 这段 SSE 是否看起来是**完整**的:出现 `[DONE]`,或至少出现过一次结束原因。
 * 用于把「上游中途断线」和「正常结束」区分开。
 */
export function sseLooksComplete(text) {
  const body = String(text);
  if (sseHasDone(body)) return true;
  return /"finish_reason"\s*:\s*"(?:stop|length|tool_calls|content_filter|function_call)"/.test(body);
}

/**
 * 构造一个 OpenAI 风格的 SSE 错误事件。
 *
 * 流已经开始后再出问题,没法改 HTTP 状态码了,只能按 OpenAI 的惯例往流里写一个
 * `{"error": …}` 载荷,让客户端据此报错,而不是把截断的输出当成正常结束。
 */
export function formatSseError(message, { type = 'upstream_error' } = {}) {
  return `data: ${JSON.stringify({ error: { message, type } })}\n\n`;
}

/**
 * 把 WorkBuddy 的 SSE 流聚合为一个标准的非流式 completion 响应。
 *
 * @param {string} sseText 原始 `text/event-stream` 响应体
 * @param {string} [model]  回显的模型 id
 * @returns {object} OpenAI chat completion
 */
export function aggregateSse(sseText, model) {
  let content = '';
  let reasoning = '';
  const toolCalls = new Map();
  let finishReason = 'stop';
  let usage;
  let id = '';
  let created = Math.floor(Date.now() / 1000);

  for (const payload of iterSseData(sseText)) {
    if (payload.id) id = payload.id;
    if (payload.created) created = payload.created;
    if (payload.usage) usage = payload.usage;

    const choice = payload.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string') content += delta.content;

    const thought = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
    if (typeof thought === 'string') reasoning += thought;

    for (const call of delta.tool_calls ?? []) accumulateToolCall(toolCalls, call);

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  }

  return {
    id: id || 'chatcmpl-workbuddy',
    object: 'chat.completion',
    created,
    model: model ?? '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.size ? 'tool_calls' : finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/** Merge one streamed `tool_calls[]` fragment into the accumulator keyed by `index`. */
export function accumulateToolCall(accumulator, call) {
  const index = call?.index ?? 0;
  const current = accumulator.get(index) ?? {
    id: call?.id ?? `call_${index}`,
    type: 'function',
    function: { name: '', arguments: '' },
  };
  if (call?.id) current.id = call.id;
  if (call?.function?.name) current.function.name += call.function.name;
  if (call?.function?.arguments) current.function.arguments += call.function.arguments;
  accumulator.set(index, current);
  return current;
}

/** Rewrite an OpenAI chunk so non-standard reasoning fields survive to the client. */
export function normalizeChunk(payload) {
  return payload;
}
