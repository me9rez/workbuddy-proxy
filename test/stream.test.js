import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { SSE_HEARTBEAT, formatSseError, sseHasDone, sseLooksComplete } from '../src/sse.js';
import { pipeUpstreamStream, startHeartbeat } from '../src/server.js';

/** 记录写入内容的假 ServerResponse。 */
function fakeRes() {
  return {
    chunks: [],
    status: null,
    headers: null,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true; // 永不触发背压,不必真的实现 drain 事件
    },
    end() {
      this.writableEnded = true;
    },
    text() {
      return this.chunks.join('');
    },
  };
}

/** 把若干字符串当作上游 SSE 体。 */
function fakeUpstream(parts, { fail = false } = {}) {
  return {
    body: (async function* generate() {
      for (const part of parts) yield Buffer.from(part, 'utf8');
      if (fail) throw new Error('socket hang up');
    })(),
  };
}

const DONE_STREAM = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

test('sseHasDone recognises both spacing variants', () => {
  assert.equal(sseHasDone('data: [DONE]\n\n'), true);
  assert.equal(sseHasDone('data:[DONE]'), true);
  assert.equal(sseHasDone('data: {"choices":[]}'), false);
});

test('sseLooksComplete accepts a finish_reason without [DONE]', () => {
  assert.equal(sseLooksComplete(DONE_STREAM), true);
  assert.equal(sseLooksComplete('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'), true);
  assert.equal(sseLooksComplete('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'), false);
  assert.equal(sseLooksComplete(''), false);
});

test('formatSseError produces an OpenAI-shaped error event', () => {
  const text = formatSseError('boom');
  assert.match(text, /^data: /);
  assert.match(text, /\n\n$/);
  assert.deepEqual(JSON.parse(text.slice(6).trim()), { error: { message: 'boom', type: 'upstream_error' } });
});

test('startHeartbeat writes comment lines and stops cleanly', async () => {
  const res = fakeRes();
  const stop = startHeartbeat(res, 10);
  await delay(35);
  stop();
  const after = res.chunks.length;
  assert.ok(after >= 2, `expected at least 2 heartbeats, got ${after}`);
  assert.equal(res.chunks[0], SSE_HEARTBEAT);
  await delay(25);
  assert.equal(res.chunks.length, after, 'no writes after stop()');
});

test('startHeartbeat with a non-positive interval is a no-op', async () => {
  const res = fakeRes();
  startHeartbeat(res, 0)();
  startHeartbeat(res, -1)();
  await delay(15);
  assert.deepEqual(res.chunks, []);
});

test('pipeUpstreamStream forwards a complete stream verbatim', async () => {
  const res = fakeRes();
  await pipeUpstreamStream(fakeUpstream([DONE_STREAM]), res, { heartbeatMs: 0, logger: { error() {} } });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.text(), DONE_STREAM);
  assert.equal(res.writableEnded, true);
  assert.equal(res.text().includes('"error"'), false);
});

test('pipeUpstreamStream reports an upstream failure as an SSE error event', async () => {
  const errors = [];
  const res = fakeRes();
  await pipeUpstreamStream(fakeUpstream(['data: {"choices":[]}\n\n'], { fail: true }), res, {
    heartbeatMs: 0,
    logger: { error: (m) => errors.push(m) },
  });

  assert.match(res.text(), /上游流中断/);
  assert.match(res.text(), /socket hang up/);
  assert.equal(errors.length, 1);
  assert.equal(res.writableEnded, true);
});

test('pipeUpstreamStream flags a stream that ends without a terminator', async () => {
  const errors = [];
  const res = fakeRes();
  await pipeUpstreamStream(fakeUpstream(['data: {"choices":[{"delta":{"content":"half"}}]}\n\n']), res, {
    heartbeatMs: 0,
    logger: { error: (m) => errors.push(m) },
  });

  assert.match(res.text(), /未收到结束标记/);
  assert.equal(errors.length, 1);
});

test('pipeUpstreamStream reports a missing body', async () => {
  const res = fakeRes();
  await pipeUpstreamStream({ body: null }, res, { heartbeatMs: 0, logger: { error() {} } });
  assert.match(res.text(), /没有返回响应体/);
});

test('pipeUpstreamStream detects [DONE] split across chunks', async () => {
  const res = fakeRes();
  await pipeUpstreamStream(fakeUpstream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DO', 'NE]\n\n']), res, {
    heartbeatMs: 0,
    logger: { error() {} },
  });
  assert.equal(res.text().includes('"error"'), false, 'a split [DONE] must still count as complete');
});
