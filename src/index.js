/**
 * 编程接口。
 *
 * ```js
 * import { login, fetchModels, ensureFreshSession, sessionCredential, startServer } from 'workbuddy-proxy';
 *
 * await login();                                  // 交互式浏览器登录
 * const session = await ensureFreshSession();
 * const models = await fetchModels(sessionCredential(session));
 * startServer({ port: 8788 });
 * ```
 */

export { login, accountLabel } from './auth.js';
export {
  ensureFreshSession,
  refreshSession,
  loadStore,
  saveStore,
  clearStore,
  activeSession,
  findSession,
  upsertSession,
  removeSession,
  setActiveSession,
  listAccounts,
  sessionId,
  storeSummary,
  loadSession,
  saveSession,
  sessionSummary,
  needsRefresh,
  refreshExpired,
  withExpiry,
} from './session.js';
export { fetchModels, parseCatalog, sessionCredential, readCache, writeCache, clearCache } from './catalog.js';
export { startServer, createHandler, startHeartbeat, pipeUpstreamStream, tokensMatch, bearerToken } from './server.js';
export { resolveLocalToken } from './cli.js';
export { aggregateSse, iterSseData, accumulateToolCall, sseHasDone, sseLooksComplete, formatSseError } from './sse.js';
export { openInBrowser, browserCommand } from './browser.js';
export { run, parseArgs, formatModels, formatHermesSnippet } from './cli.js';
export { WorkBuddyError, pluginRequest, pollPlugin } from './api.js';
export * from './constants.js';
