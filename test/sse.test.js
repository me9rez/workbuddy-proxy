import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateSse, accumulateToolCall, iterSseData } from '../src/sse.js';

const chunk = (delta, extra = {}) =>
  `data: ${JSON.stringify({ id: 'cmb-1', created: 1, model: 'hy3', choices: [{ index: 0, delta, ...extra }] })}\n\n`;

test('iterSseData yields payloads and skips [DONE] and malformed chunks', () => {
  const body = 'data: {"a":1}\n\ndata: not-json\n\ndata: [DONE]\n\ndata: {"b":2}\n\n';
  assert.deepEqual([...iterSseData(body)], [{ a: 1 }, { b: 2 }]);
});

test('iterSseData tolerates CRLF and non-data lines', () => {
  const body = 'event: message\r\ndata: {"ok":true}\r\n\r\n: keep-alive\r\n';
  assert.deepEqual([...iterSseData(body)], [{ ok: true }]);
});

test('aggregateSse folds text deltas into one completion', () => {
  const body = chunk({ role: 'assistant', content: '' }) + chunk({ content: '你' }) + chunk({ content: '好' }, { finish_reason: 'stop' });
  const out = aggregateSse(body, 'hy3');

  assert.equal(out.object, 'chat.completion');
  assert.equal(out.model, 'hy3');
  assert.equal(out.id, 'cmb-1');
  assert.equal(out.choices[0].message.content, '你好');
  assert.equal(out.choices[0].message.role, 'assistant');
  assert.equal(out.choices[0].finish_reason, 'stop');
});

test('aggregateSse keeps reasoning text separate from content', () => {
  const body = chunk({ reasoning_content: '想一下' }) + chunk({ content: '答案' }, { finish_reason: 'stop' });
  const out = aggregateSse(body, 'hy3');
  assert.equal(out.choices[0].message.content, '答案');
  assert.equal(out.choices[0].message.reasoning_content, '想一下');
});

test('aggregateSse reassembles tool calls split across fragments', () => {
  const body =
    chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_', arguments: '{"pa' } }] }) +
    chunk({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.txt"}' } }] }) +
    chunk({}, { finish_reason: 'tool_calls' });

  const out = aggregateSse(body, 'hy3');
  const call = out.choices[0].message.tool_calls[0];
  assert.equal(call.id, 'call_a');
  assert.equal(call.function.name, 'read_file');
  assert.deepEqual(JSON.parse(call.function.arguments), { path: 'a.txt' });
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
});

test('aggregateSse carries usage and falls back to a placeholder id', () => {
  const body = `data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\n`;
  const out = aggregateSse(body, 'm');
  assert.equal(out.usage.total_tokens, 3);
  assert.equal(out.id, 'chatcmpl-workbuddy');
});

test('accumulateToolCall ignores an empty fragment', () => {
  const acc = new Map();
  accumulateToolCall(acc, { index: 0, function: {} });
  assert.equal(acc.get(0).function.name, '');
  assert.equal(acc.get(0).function.arguments, '');
});
