/**
 * 凭据存储,支持多账号。
 *
 * 磁盘格式(`STATE_DIR/session.json`):
 *
 * ```json
 * {
 *   "version": 1,
 *   "activeId": "ab12cd34ef56aa78",
 *   "sessions": [
 *     { "id": "ab12…", "label": "example", "auth": {…}, "account": {…}, "savedAt": "…" }
 *   ]
 * }
 * ```
 *
 * 旧版单账号格式(`{ auth, account }`)在首次读取时自动迁移,升级不丢数据。
 * 令牌绝不写入日志;`whoami` 与 `accounts` 只输出 id/名称与过期时间。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { STATE_DIR, SESSION_FILE, REFRESH_SKEW_MS, REQUEST_HEADERS } from './constants.js';
import { pluginRequest, WorkBuddyError } from './api.js';

export const STORE_VERSION = 1;

/** Create `STATE_DIR` if it does not exist yet. */
export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

/** Stable, non-secret id for an account: a digest of its refresh token. */
export function sessionId(session) {
  const token = session?.auth?.refreshToken ?? session?.auth?.accessToken;
  if (typeof token !== 'string' || !token) throw new WorkBuddyError('登录会话缺少账号标识和令牌');
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Human label for an account payload. */
export function accountLabel(account) {
  if (!account) return null;
  return account.nickname ?? account.userName ?? account.userNickname ?? account.uid ?? null;
}

/** An empty store. */
export function newStore() {
  return { version: STORE_VERSION, activeId: null, sessions: [] };
}

/** Coerce arbitrary input into a valid session record. */
export function normalizeSession(session, now = Date.now()) {
  if (!session?.auth?.accessToken) throw new WorkBuddyError('登录会话无效：缺少访问令牌');
  const id = session.id ?? sessionId(session);
  return {
    id,
    label: session.label ?? accountLabel(session.account) ?? id,
    auth: withExpiry(session.auth, now),
    account: session.account ?? null,
    savedAt: session.savedAt ?? new Date(now).toISOString(),
    refreshedAt: session.refreshedAt ?? null,
  };
}

/**
 * Read the store, migrating a legacy single-account file in place.
 * @returns {{version: number, activeId: string|null, sessions: object[]}}
 */
export function loadStore() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return newStore();
  }

  // Legacy shape: { auth, account, savedAt }
  if (raw && !Array.isArray(raw.sessions) && raw.auth) {
    try {
      const session = normalizeSession(raw);
      const store = { version: STORE_VERSION, activeId: session.id, sessions: [session] };
      saveStore(store);
      return store;
    } catch {
      return newStore();
    }
  }

  if (!raw || !Array.isArray(raw.sessions)) return newStore();

  const sessions = [];
  const seen = new Set();
  for (const entry of raw.sessions) {
    try {
      const session = normalizeSession(entry);
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    } catch {
      /* skip corrupt entries rather than losing the whole store */
    }
  }
  const activeId = sessions.some((session) => session.id === raw.activeId)
    ? raw.activeId
    : (sessions[0]?.id ?? null);
  return { version: STORE_VERSION, activeId, sessions };
}

/** Persist the store (mode 0600). */
export function saveStore(store) {
  ensureStateDir();
  const normalized = {
    version: STORE_VERSION,
    activeId: store?.activeId ?? null,
    sessions: (store?.sessions ?? []).map((session) => normalizeSession(session)),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  return normalized;
}

/** Delete the credential store. @returns {boolean} whether anything was removed */
export function clearStore() {
  try {
    fs.rmSync(SESSION_FILE);
    return true;
  } catch {
    return false;
  }
}

/** Non-secret account list, for CLI output and the `/v1/accounts` endpoint. */
export function listAccounts(store) {
  return (store?.sessions ?? []).map((session) => ({
    id: session.id,
    label: session.label,
    active: session.id === store.activeId,
    userId: session.account?.uid ?? null,
    accountType: session.account?.type ?? null,
    savedAt: session.savedAt ?? null,
    refreshedAt: session.refreshedAt ?? null,
    expiresAt: session.auth?.expiresAt ? new Date(session.auth.expiresAt).toISOString() : null,
  }));
}

/** The current session, or null. */
export function activeSession(store) {
  return (store?.sessions ?? []).find((session) => session.id === store.activeId)
    ?? store?.sessions?.[0]
    ?? null;
}

/** Look a session up by id, label (case-insensitive) or 1-based index. Empty key = active. */
export function findSession(store, key) {
  const sessions = store?.sessions ?? [];
  if (key == null || key === '') return activeSession(store);
  const needle = String(key).trim();
  const byId = sessions.find((session) => session.id === needle);
  if (byId) return byId;
  const lower = needle.toLowerCase();
  const byLabel = sessions.find((session) => String(session.label ?? '').toLowerCase() === lower);
  if (byLabel) return byLabel;
  const index = Number.parseInt(needle, 10);
  if (Number.isInteger(index) && index >= 1 && index <= sessions.length) return sessions[index - 1];
  return null;
}

/** Add or replace a session; by default it becomes the active one. */
export function upsertSession(store, session, { makeActive = true } = {}) {
  const incoming = normalizeSession(session);
  const index = store.sessions.findIndex((entry) => entry.id === incoming.id);
  if (index >= 0) {
    incoming.savedAt = store.sessions[index].savedAt ?? incoming.savedAt;
    store.sessions[index] = incoming;
  } else {
    store.sessions.push(incoming);
  }
  if (makeActive || !store.activeId) store.activeId = incoming.id;
  return store;
}

/** Remove a session; the active pointer moves to the next remaining account. */
export function removeSession(store, key) {
  const target = findSession(store, key);
  if (!target) return null;
  store.sessions = store.sessions.filter((session) => session.id !== target.id);
  if (store.activeId === target.id) store.activeId = store.sessions[0]?.id ?? null;
  return target;
}

/** Point the store at a given account. @returns {object|null} the newly active session */
export function setActiveSession(store, key) {
  const target = findSession(store, key);
  if (!target) return null;
  store.activeId = target.id;
  return target;
}

/** Back-compat shim: the active session, or null. */
export function loadSession() {
  return activeSession(loadStore());
}

/** Back-compat shim: upsert a session and persist. */
export function saveSession(session) {
  const store = loadStore();
  upsertSession(store, session);
  return saveStore(store);
}

// ─────────────────────────── token lifecycle ───────────────────────────

/** Fill in absolute `expiresAt` / `refreshExpiresAt` from the relative fields upstream sends. */
export function withExpiry(auth, now = Date.now()) {
  const out = { ...auth };
  if (!out.expiresAt && Number.isFinite(out.expiresIn)) out.expiresAt = now + out.expiresIn * 1000;
  if (!out.refreshExpiresAt && Number.isFinite(out.refreshExpiresIn)) {
    out.refreshExpiresAt = now + out.refreshExpiresIn * 1000;
  }
  return out;
}

/**
 * Whether the access token is stale (or unreadable).
 * Falls back to the JWT `exp` claim when `expiresAt` is missing.
 */
export function needsRefresh(session, now = Date.now()) {
  const expiresAt = Number(session?.auth?.expiresAt);
  if (Number.isFinite(expiresAt)) return expiresAt <= now + REFRESH_SKEW_MS;
  const token = session?.auth?.accessToken;
  if (typeof token !== 'string' || !token.includes('.')) return true;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 <= now + REFRESH_SKEW_MS : true;
  } catch {
    return true;
  }
}

/** Whether the refresh token itself is past its own deadline. */
export function refreshExpired(session, now = Date.now()) {
  const deadline = Number(session?.auth?.refreshExpiresAt);
  return Number.isFinite(deadline) ? deadline <= now : false;
}

/**
 * Exchange a refresh token for a fresh access token.
 * Does not touch the store — callers persist the returned session.
 */
export async function refreshSession(session, { signal } = {}) {
  const refreshToken = session?.auth?.refreshToken;
  if (!refreshToken) throw new WorkBuddyError('登录会话缺少刷新令牌，请重新登录');

  const auth = await pluginRequest(
    '/auth/token/refresh',
    {
      method: 'POST',
      headers: {
        ...REQUEST_HEADERS,
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
      },
      body: '{}',
      signal,
    },
    '刷新令牌',
  );

  const merged = {
    ...session.auth,
    ...withExpiry(auth),
    refreshToken: auth?.refreshToken ?? refreshToken,
  };
  if (!merged.accessToken) throw new WorkBuddyError('刷新接口没有返回访问令牌');

  return { ...session, auth: merged, refreshedAt: new Date().toISOString() };
}

/**
 * Resolve a usable session for a request.
 *
 * @param {object} [options]
 * @param {string} [options.account] id / label / 1-based index; defaults to the active account
 * @param {boolean} [options.persist] write a refreshed token back to the store (default true)
 * @param {boolean} [options.fallthrough] on a failing account, try the remaining ones in order
 * @returns {Promise<object>} a session carrying a fresh access token
 */
export async function ensureFreshSession({ account, signal, persist = true, fallthrough = false } = {}) {
  const store = loadStore();
  const primary = findSession(store, account);
  if (!primary) {
    throw new WorkBuddyError(
      store.sessions.length
        ? `找不到账号「${account}」（运行 workbuddy-proxy accounts 查看）`
        : '尚未登录，请先运行：workbuddy-proxy login',
    );
  }

  const candidates = fallthrough
    ? [primary, ...store.sessions.filter((session) => session.id !== primary.id)]
    : [primary];

  let lastError;
  for (const candidate of candidates) {
    try {
      if (!needsRefresh(candidate)) return candidate;
      const fresh = await refreshSession(candidate, { signal });
      if (persist) {
        const next = loadStore();
        upsertSession(next, fresh, { makeActive: next.activeId === candidate.id });
        saveStore(next);
      }
      return fresh;
    } catch (error) {
      lastError = refreshExpired(candidate)
        ? new WorkBuddyError(`账号「${candidate.label}」的登录已过期，请重新登录`, { cause: error })
        : error;
    }
  }
  throw new WorkBuddyError(`凭据不可用：${lastError?.message ?? lastError}`, { cause: lastError });
}

/** Non-secret view of one session. */
export function sessionSummary(session) {
  if (!session) return null;
  const account = session.account ?? {};
  return {
    id: session.id ?? null,
    account: accountLabel(account),
    userId: account.uid ?? null,
    accountType: account.type ?? null,
    savedAt: session.savedAt ?? null,
    refreshedAt: session.refreshedAt ?? null,
    expiresAt: session.auth?.expiresAt ? new Date(session.auth.expiresAt).toISOString() : null,
  };
}

/** Non-secret view of the whole store. */
export function storeSummary(store) {
  return { activeId: store?.activeId ?? null, accounts: listAccounts(store) };
}
