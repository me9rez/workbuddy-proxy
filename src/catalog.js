/**
 * 模型目录。
 *
 * `GET /v3/config` 返回 `{ data: { agents: [{name, models[]}], models: [{id, …}] } }`。
 * 只有 `cli` agent 下列出的模型可用,而且该列表**按凭据**返回 —— 两把有效的 Key 可能
 * 得到不同的 id。容量取自 `maxInputTokens ?? maxAllowedSize` 与 `maxOutputTokens`。
 */

import fs from 'node:fs';
import { CONFIG_URL, MODELS_CACHE_FILE, MODELS_TTL_MS, STATE_DIR } from './constants.js';
import { credentialHeaders, WorkBuddyError } from './api.js';
import { ensureStateDir } from './session.js';

/**
 * Parse a `/v3/config` payload into a flat model list.
 *
 * @param {any} data `body.data`
 * @returns {Array<{id, name, contextWindow, maxTokens, images, reasoning, onlyReasoning, defaultEffort}>}
 */
export function parseCatalog(data) {
  const agents = Array.isArray(data?.agents) ? data.agents : (data?.agent?.agents ?? []);
  const allowed = agents.find((agent) => agent?.name === 'cli')?.models ?? [];
  const byId = new Map(
    (Array.isArray(data?.models) ? data.models : []).filter((model) => model?.id).map((model) => [model.id, model]),
  );

  const models = [];
  for (const id of allowed) {
    const raw = byId.get(id);
    if (!raw) continue;
    const contextWindow = raw.maxInputTokens ?? raw.maxAllowedSize;
    const maxTokens = raw.maxOutputTokens;
    if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens)) continue;
    models.push({
      id,
      name: raw.name ?? id,
      contextWindow,
      maxTokens,
      images: raw.supportsImages === true,
      reasoning: raw.supportsReasoning === true,
      onlyReasoning: raw.onlyReasoning === true,
      defaultEffort: typeof raw.reasoning?.effort === 'string' ? raw.reasoning.effort : null,
    });
  }
  return models;
}

/** Read the on-disk catalog cache when it is still fresh. */
export function readCache(now = Date.now()) {
  try {
    const cached = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, 'utf8'));
    if (!Array.isArray(cached?.models)) return null;
    if (!Number.isFinite(cached.at) || now - cached.at > MODELS_TTL_MS) return null;
    return cached.models;
  } catch {
    return null;
  }
}

/** Write the catalog cache. */
export function writeCache(models, now = Date.now()) {
  try {
    ensureStateDir();
    fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify({ at: now, models }, null, 2));
  } catch {
    /* a cache miss next time is acceptable */
  }
}

/** Drop the catalog cache. */
export function clearCache() {
  try {
    fs.rmSync(MODELS_CACHE_FILE);
  } catch {
    /* already gone */
  }
}

/**
 * Fetch the credential's model catalog.
 *
 * @param {{kind: 'bearer'|'api-key', value: string}} credential
 * @param {{force?: boolean, signal?: AbortSignal}} [options]
 */
export async function fetchModels(credential, { force = false, signal } = {}) {
  if (!force) {
    const cached = readCache();
    if (cached) return cached;
  }

  let response;
  try {
    response = await fetch(CONFIG_URL, {
      headers: credentialHeaders(credential),
      signal,
    });
  } catch (cause) {
    throw new WorkBuddyError(`模型目录：无法连接 WorkBuddy（${cause?.message ?? cause}）`, { cause });
  }
  if (!response.ok) throw new WorkBuddyError(`模型目录 HTTP ${response.status}`, { status: response.status });

  const body = await response.json().catch((cause) => {
    throw new WorkBuddyError('模型目录返回了无法解析的数据', { cause });
  });
  if (body?.code !== 0) throw new WorkBuddyError(`模型目录错误：${body?.msg ?? body?.code}`, { code: body?.code });

  const models = parseCatalog(body.data);
  if (models.length) writeCache(models);
  return models;
}

/** Credential view of a session (token mode). */
export function sessionCredential(session) {
  return { kind: 'bearer', value: session?.auth?.accessToken ?? '' };
}

export { STATE_DIR };
