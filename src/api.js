/**
 * WorkBuddy 插件端点的轻量客户端。
 *
 * 每个调用都返回 `{code, msg, data}`,必须**同时**检查 HTTP 状态与业务 `code` ——
 * 这里 HTTP 200 但 `code !== 0` 是正常的失败形态。
 */

import {
  PLUGIN_BASE,
  REQUEST_HEADERS,
  NO_ACCOUNT_HEADERS,
  POLL_INTERVAL_MS,
  DEFAULT_USER_AGENT,
} from './constants.js';

/** Upstream or transport failure, with the action that failed. */
export class WorkBuddyError extends Error {
  constructor(message, { cause, status, code } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WorkBuddyError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Call a plugin endpoint and unwrap `data`.
 *
 * @param {string} pathname e.g. `/auth/state?platform=CLI`
 * @param {RequestInit} options
 * @param {string} action human-readable action, used in errors
 * @returns {Promise<any>} `body.data`
 */
export async function pluginRequest(pathname, options, action) {
  let response;
  try {
    response = await fetch(`${PLUGIN_BASE}${pathname}`, options);
  } catch (cause) {
    if (options?.signal?.aborted) throw new WorkBuddyError(`${action}已取消`, { cause });
    throw new WorkBuddyError(`${action}：无法连接 WorkBuddy（${cause?.message ?? cause}）`, { cause });
  }

  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw new WorkBuddyError(`${action}：返回了无法解析的数据`, { cause, status: response.status });
  }

  if (!response.ok || body?.code !== 0) {
    const detail = body?.message ?? body?.msg ?? String(response.status);
    throw new WorkBuddyError(`${action}失败（${detail}）`, { status: response.status, code: body?.code });
  }
  return body.data;
}

/**
 * Poll a plugin endpoint until it returns a payload or the deadline passes.
 * Failures are retried; the last error is rethrown on timeout.
 */
export async function pollPlugin(pathname, headers, action, timeoutMs, { intervalMs = POLL_INTERVAL_MS, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await pluginRequest(pathname, { headers, signal }, action);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
    await sleep(intervalMs, signal);
  }
  throw lastError ?? new WorkBuddyError(`${action}超时`);
}

/** `setTimeout` that rejects when the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new WorkBuddyError('已取消'));
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WorkBuddyError('已取消'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Authorization headers for authenticated upstream calls.
 * Token credentials use `Authorization: Bearer`; API keys use `X-API-Key`.
 */
export function credentialHeaders({ kind, value }, { json = true } = {}) {
  const headers = {
    'user-agent': DEFAULT_USER_AGENT,
    'x-product': 'SaaS',
    ...(json ? { accept: 'application/json' } : {}),
  };
  if (kind === 'api-key') headers['x-api-key'] = value;
  else headers.authorization = `Bearer ${value}`;
  return headers;
}

export { REQUEST_HEADERS, NO_ACCOUNT_HEADERS };
