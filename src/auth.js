/**
 * Browser login: create a state, let the user sign in, poll for tokens and the account.
 *
 * Flow (all under PLUGIN_BASE):
 *   POST /auth/state?platform=CLI  → { state, authUrl }
 *   (user completes the login in the browser)
 *   GET  /auth/token?state=…       → { accessToken, refreshToken, expiresIn, … }
 *   GET  /login/account?state=…    → account profile
 */

import {
  REQUEST_HEADERS,
  NO_ACCOUNT_HEADERS,
  NO_ID_HEADERS,
  LOGIN_POLL_TIMEOUT_MS,
  ACCOUNT_POLL_TIMEOUT_MS,
} from './constants.js';
import { pluginRequest, pollPlugin, WorkBuddyError } from './api.js';
import { withExpiry, saveSession, sessionId, accountLabel } from './session.js';
import { openInBrowser } from './browser.js';

/**
 * Run the interactive login.
 *
 * @param {object} [options]
 * @param {(url: string, opened: boolean) => void} [options.onAuthUrl] called with the authorization URL
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} the stored session
 */
export async function login({ onAuthUrl, signal } = {}) {
  const state = await pluginRequest(
    '/auth/state?platform=CLI',
    { method: 'POST', headers: { ...REQUEST_HEADERS, ...NO_ACCOUNT_HEADERS }, body: '{}', signal },
    '创建登录会话',
  );
  if (!state?.state || !state?.authUrl) throw new WorkBuddyError('登录接口没有返回登录地址');

  const opened = openInBrowser(state.authUrl);
  onAuthUrl?.(state.authUrl, opened);

  const auth = await pollPlugin(
    `/auth/token?state=${encodeURIComponent(state.state)}`,
    NO_ACCOUNT_HEADERS,
    '等待登录',
    LOGIN_POLL_TIMEOUT_MS,
    { signal },
  );
  if (!auth?.accessToken || !auth?.refreshToken) throw new WorkBuddyError('登录接口没有返回完整令牌');

  const account = await pollPlugin(
    `/login/account?state=${encodeURIComponent(state.state)}`,
    { authorization: `Bearer ${auth.accessToken}`, ...NO_ID_HEADERS },
    '获取账号',
    ACCOUNT_POLL_TIMEOUT_MS,
    { signal },
  );

  const session = {
    id: sessionId({ auth }),
    label: accountLabel(account) ?? 'account',
    auth: withExpiry(auth),
    account,
    savedAt: new Date().toISOString(),
  };
  // Adds the account to the store (refreshing it in place when it already exists)
  // and makes it the active one.
  saveSession(session);
  return session;
}

export { accountLabel };
