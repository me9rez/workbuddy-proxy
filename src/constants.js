/**
 * 端点、Header 与本地路径。
 *
 * 上游接口不是公开、稳定承诺的开发者 API:路径与 Header 可能随 CodeBuddy 版本变化。
 * 所有可能漂移的东西都集中在这里。
 */

import os from 'node:os';
import path from 'node:path';

/** Account/auth + token endpoints. */
export const PLUGIN_BASE = 'https://copilot.tencent.com/v2/plugin';

/** OpenAI-compatible chat completions (SSE only — see `sse.js`). */
export const CHAT_URL = 'https://copilot.tencent.com/v2/chat/completions';

/** Model + product configuration for the current credential. */
export const CONFIG_URL = 'https://copilot.tencent.com/v3/config';

/** Sent on every upstream call; the server validates its shape. */
export const DEFAULT_USER_AGENT = 'CLI/unknown CodeBuddy/2.137.1';

/** Base request headers for plugin endpoints. */
export const REQUEST_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': DEFAULT_USER_AGENT,
  'x-product': 'SaaS',
};

/** Anonymous headers: suppress account/user/enterprise lookup for unauthenticated calls. */
export const NO_ACCOUNT_HEADERS = {
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
};

/** Same as NO_ACCOUNT_HEADERS but keeping the Authorization header we pass ourselves. */
export const NO_ID_HEADERS = {
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
};

/** Where credentials and caches live. Override with WORKBUDDY_PROXY_HOME. */
export const STATE_DIR = process.env.WORKBUDDY_PROXY_HOME?.trim()
  ? path.resolve(process.env.WORKBUDDY_PROXY_HOME.trim())
  : path.join(os.homedir(), '.workbuddy-proxy');

export const SESSION_FILE = path.join(STATE_DIR, 'session.json');
export const MODELS_CACHE_FILE = path.join(STATE_DIR, 'models.json');

/**
 * SSE 心跳间隔(毫秒)。**默认关闭**。
 * 用 `serve --heartbeat <秒>` 显式开启。
 */
export const HEARTBEAT_INTERVAL_MS = 0;

/** 模型目录缓存时长(ms)。 */
export const MODELS_TTL_MS = 10 * 60 * 1000;

/** Refresh the access token this many ms before it expires. */
export const REFRESH_SKEW_MS = 2 * 60 * 1000;

/** How the login poll backs off. */
export const POLL_INTERVAL_MS = 1000;
export const LOGIN_POLL_TIMEOUT_MS = 10 * 60 * 1000;
export const ACCOUNT_POLL_TIMEOUT_MS = 60 * 1000;

export const DEFAULT_PORT = 8788;
export const DEFAULT_HOST = '127.0.0.1';
