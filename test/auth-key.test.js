import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveLocalToken } from '../src/cli.js';
import { createHandler, tokensMatch, bearerToken } from '../src/server.js';

const quiet = { log() {}, error() {} };

// ── resolveLocalToken:三种来源与优先级 ─────────────────────────────────

test('resolveLocalToken prefers --token over everything else', () => {
  const token = resolveLocalToken(
    { token: 'sk-flag', 'token-file': '/nope' },
    { WORKBUDDY_PROXY_API_KEY: 'sk-env' },
  );
  assert.equal(token, 'sk-flag');
});

test('resolveLocalToken reads --token-file when --token is absent', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-key-'));
  const file = path.join(dir, 'api-key.txt');
  writeFileSync(file, 'sk-from-file\n', 'utf8');

  const token = resolveLocalToken({ 'token-file': file }, { WORKBUDDY_PROXY_API_KEY: 'sk-env' });
  assert.equal(token, 'sk-from-file');
});

test('resolveLocalToken falls back to WORKBUDDY_PROXY_API_KEY', () => {
  assert.equal(resolveLocalToken({}, { WORKBUDDY_PROXY_API_KEY: 'sk-env' }), 'sk-env');
  assert.equal(resolveLocalToken({}, { WORKBUDDY_PROXY_API_KEY: '  sk-padded  ' }), 'sk-padded');
});

test('resolveLocalToken returns empty string (no auth) when nothing is configured', () => {
  assert.equal(resolveLocalToken({}, {}), '');
  assert.equal(resolveLocalToken({}, { WORKBUDDY_PROXY_API_KEY: '' }), '');
});

test('resolveLocalToken throws a readable error for a missing --token-file', () => {
  assert.throws(
    () => resolveLocalToken({ 'token-file': path.join(tmpdir(), 'definitely-missing-key.txt') }, {}),
    /读取 --token-file 失败/,
  );
});

// ── tokensMatch:常量时间比较 ───────────────────────────────────────────

test('tokensMatch accepts an exact match and rejects everything else', () => {
  assert.equal(tokensMatch('sk-abc', 'sk-abc'), true);
  assert.equal(tokensMatch('sk-abd', 'sk-abc'), false);
  assert.equal(tokensMatch('sk-ab', 'sk-abc'), false);   // 长度不同
  assert.equal(tokensMatch('', 'sk-abc'), false);
  assert.equal(tokensMatch('sk-abc', ''), false);        // 空期望值永远不匹配
});

test('bearerToken parses the Authorization header case-insensitively', () => {
  assert.equal(bearerToken('Bearer sk-abc'), 'sk-abc');
  assert.equal(bearerToken('bearer   sk-abc  '), 'sk-abc');
  assert.equal(bearerToken('Basic sk-abc'), '');
  assert.equal(bearerToken(undefined), '');
});

// ── HTTP 层:鉴权与免鉴权探测 ──────────────────────────────────────────

function fakeReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return { method, url, headers: { host: 'localhost', ...headers } };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers ?? {})) this.headers[k.toLowerCase()] = v;
      return this;
    },
    end(text) { this.body = text ?? ''; },
  };
}

test('/healthz is reachable without a key and leaks nothing', async () => {
  const handler = createHandler({ localToken: 'sk-abc', logger: quiet });
  const res = fakeRes();
  await handler(fakeReq({ url: '/healthz' }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('/ping behaves like /healthz', async () => {
  const handler = createHandler({ localToken: 'sk-abc', logger: quiet });
  const res = fakeRes();
  await handler(fakeReq({ url: '/ping' }), res);
  assert.equal(res.statusCode, 200);
});

test('requests without a key get 401 and a WWW-Authenticate challenge', async () => {
  const handler = createHandler({ localToken: 'sk-abc', logger: quiet });
  const res = fakeRes();
  await handler(fakeReq({ url: '/v1/models' }), res);

  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'], /Bearer/);
  assert.match(JSON.parse(res.body).error.message, /本地令牌无效/);
});

test('requests with the right key pass the gate', async () => {
  const handler = createHandler({ localToken: 'sk-abc', logger: quiet });
  const res = fakeRes();
  await handler(fakeReq({ url: '/health', headers: { authorization: 'Bearer sk-abc' } }), res);

  // 通过鉴权:不是 401,响应里也没有错误体(内容取决于本机是否已登录,不做假设)
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).error, undefined);
});

test('no key configured means no auth (loopback-only default)', async () => {
  const handler = createHandler({ localToken: '', logger: quiet });
  const res = fakeRes();
  await handler(fakeReq({ url: '/health' }), res);
  assert.equal(res.statusCode, 200);
});
