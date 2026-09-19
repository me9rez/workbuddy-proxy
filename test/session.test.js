import test from 'node:test';
import assert from 'node:assert/strict';

import { withExpiry, needsRefresh, sessionSummary } from '../src/session.js';

const NOW = 1_700_000_000_000;

test('withExpiry derives absolute timestamps from relative fields', () => {
  const auth = withExpiry({ accessToken: 'a', expiresIn: 3600, refreshExpiresIn: 86400 }, NOW);
  assert.equal(auth.expiresAt, NOW + 3_600_000);
  assert.equal(auth.refreshExpiresAt, NOW + 86_400_000);
});

test('withExpiry keeps existing absolute timestamps', () => {
  const auth = withExpiry({ expiresAt: 42 }, NOW);
  assert.equal(auth.expiresAt, 42);
});

test('needsRefresh treats a token expiring inside the skew window as stale', () => {
  assert.equal(needsRefresh({ auth: { expiresAt: NOW + 60_000 } }, NOW), true);
  assert.equal(needsRefresh({ auth: { expiresAt: NOW + 10 * 60_000 } }, NOW), false);
});

test('needsRefresh falls back to the JWT exp claim', () => {
  const jwt = (expSeconds) => `header.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.sig`;
  const soon = Math.floor((NOW + 60_000) / 1000);
  const later = Math.floor((NOW + 3600_000) / 1000);

  assert.equal(needsRefresh({ auth: { accessToken: jwt(soon) } }, NOW), true);
  assert.equal(needsRefresh({ auth: { accessToken: jwt(later) } }, NOW), false);
  assert.equal(needsRefresh({ auth: { accessToken: 'opaque' } }, NOW), true);
});

test('sessionSummary exposes no secrets', () => {
  const summary = sessionSummary({
    auth: { accessToken: 'secret', refreshToken: 'secret2', expiresAt: NOW },
    account: { nickname: '示例账号', uid: 'u1', type: 'personal' },
    savedAt: 'x',
  });
  assert.equal(summary.account, '示例账号');
  assert.equal(summary.userId, 'u1');
  assert.equal(JSON.stringify(summary).includes('secret'), false);
});
