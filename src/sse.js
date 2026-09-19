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

/**
 * Fold an SSE stream into a single OpenAI-shaped `chat.completion`.
 *
 * Text, reasoning and tool calls are all incremental on the wire:
 * `delta.tool_calls[].function.name` / `.arguments` arrive in fragments and must be
 * concatenated per `index` before the JSON can be parsed by the caller.
 *
 * @param {string} sseText raw `text/event-stream` body
 * @param {string} [model] model id to echo back
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
