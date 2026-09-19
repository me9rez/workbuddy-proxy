import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeHeaderValue, requestedAccount, bearerToken, sendJson, readBody } from '../src/server.js';

test('decodeHeaderValue recovers UTF-8 text sent through a latin-1 header', () => {
  // Clients encode a UTF-8 label into header bytes; Node surfaces them latin-1-decoded.
  const mojibake = Buffer.from('示例账号', 'utf8').toString('latin1');
  assert.notEqual(mojibake, '示例账号');
  assert.equal(decodeHeaderValue(mojibake), '示例账号');
});

test('decodeHeaderValue leaves ASCII and invalid sequences untouched', () => {
  assert.equal(decodeHeaderValue('ghost'), 'ghost');
  assert.equal(decodeHeaderValue('bbba3521e3dde284'), 'bbba3521e3dde284');
  assert.equal(decodeHeaderValue(undefined), '');
  // A lone 0xFF byte cannot be UTF-8: keep the original rather than throwing.
  assert.equal(decodeHeaderValue('\xff\xfe'), '\xff\xfe');
});

test('requestedAccount prefers the header over the query string', () => {
  const url = new URL('http://x/v1/models?account=from-query');
  assert.equal(requestedAccount({ headers: { 'x-workbuddy-account': 'from-header' } }, url), 'from-header');
  assert.equal(requestedAccount({ headers: {} }, url), 'from-query');
  assert.equal(requestedAccount({ headers: {} }, new URL('http://x/v1/models')), '');
});

test('requestedAccount decodes a UTF-8 label in the header', () => {
  const header = Buffer.from('示例账号', 'utf8').toString('latin1');
  assert.equal(requestedAccount({ headers: { 'x-workbuddy-account': header } }, new URL('http://x/')), '示例账号');
});

test('bearerToken parses an Authorization header case-insensitively', () => {
  assert.equal(bearerToken('Bearer sk-abc'), 'sk-abc');
  assert.equal(bearerToken('bearer   sk-abc  '), 'sk-abc');
  assert.equal(bearerToken('Basic sk-abc'), '');
  assert.equal(bearerToken(undefined), '');
});

test('sendJson writes a JSON body with a matching content-length', () => {
  const captured = {};
  const res = {
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body) {
      captured.body = body;
    },
  };
  sendJson(res, 201, { hello: '你好' });

  assert.equal(captured.status, 201);
  assert.equal(captured.headers['content-length'], Buffer.byteLength(captured.body));
  assert.deepEqual(JSON.parse(captured.body), { hello: '你好' });
});

test('readBody rejects a body past the limit', async () => {
  const req = {
    on(event, handler) {
      if (event === 'data') handler(Buffer.alloc(64));
      if (event === 'end') handler();
      return this;
    },
    destroy() {},
  };
  await assert.rejects(() => readBody(req, 8), /请求体超过/);
});

test('readBody concatenates chunks', async () => {
  const listeners = {};
  const req = {
    on(event, handler) {
      listeners[event] = handler;
      return this;
    },
  };
  const promise = readBody(req, 1024);
  listeners.data(Buffer.from('{"a":'));
  listeners.data(Buffer.from('1}'));
  listeners.end();
  assert.equal(await promise, '{"a":1}');
});
