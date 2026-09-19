import test from 'node:test';
import assert from 'node:assert/strict';

import {
  newStore,
  upsertSession,
  findSession,
  removeSession,
  setActiveSession,
  listAccounts,
  sessionId,
  normalizeSession,
} from '../src/session.js';

/** Build a minimal session record without touching the network or disk. */
const session = (token, label) => ({
  auth: { accessToken: `access.${token}`, refreshToken: `refresh.${token}`, expiresIn: 3600 },
  account: { nickname: label, uid: `uid-${label}` },
});

test('sessionId is stable for the same refresh token and differs across accounts', () => {
  const a = sessionId(session('aaa', 'A'));
  assert.equal(a, sessionId(session('aaa', 'A')));
  assert.notEqual(a, sessionId(session('bbb', 'B')));
  assert.equal(a.length, 16);
});

test('sessionId rejects a session without tokens', () => {
  assert.throws(() => sessionId({ auth: {} }), /缺少账号标识和令牌/);
});

test('normalizeSession derives id, label and expiry', () => {
  const normalized = normalizeSession(session('aaa', '示例账号'), 1_700_000_000_000);
  assert.equal(normalized.label, '示例账号');
  assert.equal(normalized.id, sessionId(session('aaa', '示例账号')));
  assert.equal(normalized.auth.expiresAt, 1_700_000_000_000 + 3_600_000);
});

test('upsertSession adds an account and makes it active', () => {
  const store = newStore();
  upsertSession(store, session('aaa', 'A'));
  assert.equal(store.sessions.length, 1);
  assert.equal(store.activeId, store.sessions[0].id);

  upsertSession(store, session('bbb', 'B'));
  assert.equal(store.sessions.length, 2);
  assert.equal(store.activeId, sessionId(session('bbb', 'B')));
});

test('upsertSession replaces an existing account in place, keeping its savedAt', () => {
  const store = newStore();
  upsertSession(store, session('aaa', 'A'));
  const firstSavedAt = store.sessions[0].savedAt;

  upsertSession(store, { ...session('aaa', 'A'), account: { nickname: 'A renamed' } }, { makeActive: false });

  assert.equal(store.sessions.length, 1);
  assert.equal(store.sessions[0].label, 'A renamed');
  assert.equal(store.sessions[0].savedAt, firstSavedAt);
});

test('upsertSession with makeActive=false leaves the active account alone', () => {
  const store = newStore();
  upsertSession(store, session('aaa', 'A'));
  const active = store.activeId;
  upsertSession(store, session('bbb', 'B'), { makeActive: false });
  assert.equal(store.activeId, active);
});

test('findSession resolves by id, by label (case-insensitive) and by index', () => {
  const store = newStore();
  upsertSession(store, session('aaa', 'Alpha'));
  upsertSession(store, session('bbb', 'Beta'));

  assert.equal(findSession(store, 'ALPHA').label, 'Alpha');
  assert.equal(findSession(store, sessionId(session('bbb', 'Beta'))).label, 'Beta');
  assert.equal(findSession(store, '2').label, 'Beta');
  assert.equal(findSession(store, '99'), null);
  assert.equal(findSession(store, 'nope'), null);
});

test('findSession with an empty key returns the active account', () => {
  const store = newStore();
  upsertSession(store, session('aaa', 'A'));
  upsertSession(store, session('bbb', 'B'));
  setActiveSession(store, 'A');
  assert.equal(findSession(store, '').label, 'A');
  assert.equal(findSession(store, undefined).label, 'A');
});

test('setActiveSession switches accounts and reports an unknown key', () => {
  const store = newStore();
  upsertSession(store, session('aaa', 'A'));
  upsertSession(store, session('bbb', 'B'));

  assert.equal(setActiveSession(store, 'A').label, 'A');
  assert.equal(store.activeId, sessionId(session('aaa', 'A')));
  assert.equal(setActiveSession(store, 'ghost'), null);
});

test('removeSession moves the active pointer to a remaining account', () => {
  const store = newStore();
  upsertSession(store, session('aaa', 'A'));
  upsertSession(store, session('bbb', 'B')); // becomes active

  const removed = removeSession(store, 'B');
  assert.equal(removed.label, 'B');
  assert.equal(store.sessions.length, 1);
  assert.equal(store.activeId, sessionId(session('aaa', 'A')));
});

test('removeSession on the last account clears the active pointer', () => {
  const store = newStore();
  upsertSession(store, session('aaa', 'A'));
  removeSession(store, 'A');
  assert.deepEqual(store.sessions, []);
  assert.equal(store.activeId, null);
});

test('listAccounts marks the active account and leaks no tokens', () => {
  const store = newStore();
  upsertSession(store, session('aaa', 'A'));
  upsertSession(store, session('bbb', 'B'));

  const accounts = listAccounts(store);
  assert.equal(accounts.length, 2);
  assert.equal(accounts.filter((a) => a.active).length, 1);
  assert.equal(accounts.find((a) => a.active).label, 'B');
  assert.equal(JSON.stringify(accounts).includes('refresh.'), false);
  assert.equal(JSON.stringify(accounts).includes('access.'), false);
});
