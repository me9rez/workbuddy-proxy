import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, formatModels, formatAccounts, formatHermesSnippet } from '../src/cli.js';

test('parseArgs separates flags from positional arguments', () => {
  const { _, flags } = parseArgs(['serve', '--port', '9000', '--token', 'sk-x', '--verbose']);
  assert.deepEqual(_, ['serve']);
  assert.equal(flags.port, '9000');
  assert.equal(flags.token, 'sk-x');
  assert.equal(flags.verbose, true);
});

test('formatModels reports capacity, vision and reasoning', () => {
  const text = formatModels([
    { id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, images: true, reasoning: true },
  ]);
  assert.match(text, /共 1 个模型/);
  assert.match(text, /hy3/);
  assert.match(text, /192000/);
  assert.match(text, /图片/);
  assert.match(text, /思考/);
});

test('formatAccounts marks the active account and points at the login command when empty', () => {
  assert.match(formatAccounts([]), /还没有账号/);

  const text = formatAccounts([
    { id: 'aaaa1111', label: '工作号', active: false, expiresAt: '2026-11-13T00:00:00.000Z' },
    { id: 'bbbb2222', label: '示例账号', active: true, expiresAt: null },
  ]);
  assert.match(text, /共 2 个账号/);
  assert.match(text, /\* {2}2 {2}bbbb2222/);
  assert.match(text, /过期时间 未知/);
});

test('formatHermesSnippet emits a providers block with context lengths', () => {
  const yaml = formatHermesSnippet([
    { id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, images: true },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, maxTokens: 64000, images: false },
  ]);
  assert.match(yaml, /^ {2}workbuddy-proxy:/m);
  assert.match(yaml, /base_url: http:\/\/127\.0\.0\.1:8788\/v1/);
  assert.match(yaml, / {6}hy3:\n {8}context_length: 192000\n {8}supports_vision: true/);
  assert.equal(/glm-5\.2:\n {8}supports_vision/.test(yaml), false);
});
