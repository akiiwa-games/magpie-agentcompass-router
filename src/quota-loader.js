/**
 * Explicit Quota Snapshot Loader for Bun (`magpie.hooks` & `/v1/systemone`)
 *
 * By default, performs zero disk reads and never walks parent directories or probes
 * Magpie's internal configuration directory.
 * Only reads from:
 * 1. Explicit `options.quotas` in-memory object/array (returned immediately)
 * 2. Explicit `options.quotasPath` / `options.quotaFile` / `options.magpieConfigDir` when explicitly configured by the user
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeQuotaSnapshot } from "./quota.js";

const CACHE_TTL_MS = 5000;
const OPTION_KEYS = new Set(["usage_max_age_hours", "usageMaxAgeHours"]);

let cachedPath = "";
let cachedMtimeMs = 0;
let cachedReadAt = 0;
let cachedQuotas = null;
let lastGoodAt = null;
let loadStatus = { configured: false, ok: true, path: "", cause: null, detail: null };
let reportedSignature = "";

/**
 * Resolve an explicitly configured quotas file path if provided in `options`.
 * Never walks parent directories or probes `$HOME` / `$XDG_CONFIG_HOME`.
 */
export function resolveMagpieQuotasFile(options = {}) {
  const explicitFile = options.quotasPath || options.quotaFile;
  if (typeof explicitFile === "string" && explicitFile.trim()) {
    return explicitFile.trim();
  }

  const explicitDir = options.magpieConfigDir;
  if (typeof explicitDir === "string" && explicitDir.trim()) {
    const dir = explicitDir.trim();
    const candidate = join(dir, "quotas.json");
    if (existsSync(candidate)) return candidate;
    const nested = join(dir, "magpie", "quotas.json");
    if (existsSync(nested)) return nested;
    return candidate;
  }

  return "";
}

/** Why the last explicitly configured quotas file could not be used (`ok: true` when it could). */
export function getQuotasLoadStatus() {
  return { ...loadStatus };
}

function describeSchemaProblem(parsed, nowMs) {
  if (!parsed || typeof parsed !== "object") return "top level is not an object or array";
  const keys = Array.isArray(parsed) ? parsed : Object.keys(parsed).filter((k) => !OPTION_KEYS.has(k));
  if (keys.length > 0 && normalizeQuotaSnapshot(parsed, nowMs).length === 0) {
    return "no account entries found";
  }
  return null;
}

/** Log once per change of state, not on every request. */
function reportLoad(signature, message) {
  if (signature === reportedSignature) return;
  reportedSignature = signature;
  if (message) console.warn(`agentcompass: ${message}`);
}

/**
 * The configured quotas file could not be used. The last good snapshot (if any) is kept, so its readings
 * age out through the 6h rule, and a pool-level `usage_failing` entry (`quotas_unreadable`) is added so the
 * account list and decision warnings say so. Dispatch is not blocked by this entry.
 */
function loadFailed(qPath, cause, detail, nowMs) {
  loadStatus = { configured: true, ok: false, path: qPath, cause, detail: detail || null };
  const text = `quotas_unreadable: ${cause}${detail ? ` (${detail})` : ""} at ${qPath}`;
  reportLoad(`${qPath}|${cause}|${detail || ""}`, `quotas file unusable, ${text}`);
  const lastGood = cachedQuotas && cachedPath === qPath ? cachedQuotas : null;
  const entry = {
    provider: "pool",
    name: "quotas",
    pool_level: true,
    status: "error",
    error: { message: text },
    ...(lastGoodAt !== null ? { last_success_at: lastGoodAt } : {}),
  };
  if (Array.isArray(lastGood)) return [...lastGood, entry];
  const { name, ...keyed } = entry;
  if (lastGood?.accounts && typeof lastGood.accounts === "object" && !Array.isArray(lastGood.accounts)) {
    return { ...lastGood, accounts: { ...lastGood.accounts, "pool/quotas": keyed } };
  }
  return { ...(lastGood || {}), "pool/quotas": keyed };
}

/**
 * Load live subscription quotas from `options.quotas` or an explicitly configured `options.quotasPath` / `options.quotaFile`.
 * No configured source -> `null`, no warning. A configured file that is missing, unreadable, not JSON or
 * the wrong shape is never silent: see `loadFailed` and `getQuotasLoadStatus`.
 */
export function loadLiveQuotas(options = {}, nowMs = Date.now()) {
  if (options.quotas && typeof options.quotas === "object") {
    return options.quotas;
  }
  if (options.disableQuotas === true) {
    return null;
  }

  const qPath = resolveMagpieQuotasFile(options);
  if (!qPath) {
    loadStatus = { configured: false, ok: true, path: "", cause: null, detail: null };
    return null;
  }

  if (
    loadStatus.ok &&
    cachedQuotas &&
    cachedPath === qPath &&
    nowMs - cachedReadAt < CACHE_TTL_MS
  ) {
    return cachedQuotas;
  }

  let rawText;
  let mtimeMs;
  try {
    if (!existsSync(qPath)) return loadFailed(qPath, "missing", null, nowMs);
    const st = statSync(qPath);
    mtimeMs = st.mtimeMs;
    if (loadStatus.ok && cachedQuotas && cachedPath === qPath && st.mtimeMs === cachedMtimeMs) {
      cachedReadAt = nowMs;
      lastGoodAt = new Date(nowMs).toISOString();
      return cachedQuotas;
    }
    rawText = readFileSync(qPath, "utf8");
  } catch (err) {
    return loadFailed(qPath, "unreadable", err?.code || "read error", nowMs);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return loadFailed(qPath, "invalid_json", null, nowMs);
  }
  const problem = describeSchemaProblem(parsed, nowMs);
  if (problem) return loadFailed(qPath, "wrong_schema", problem, nowMs);

  cachedPath = qPath;
  cachedMtimeMs = mtimeMs;
  cachedReadAt = nowMs;
  cachedQuotas = parsed;
  lastGoodAt = new Date(nowMs).toISOString();
  loadStatus = { configured: true, ok: true, path: qPath, cause: null, detail: null };
  reportLoad("", reportedSignature ? `quotas file readable again at ${qPath}` : "");
  return parsed;
}

export function clearQuotasCache() {
  cachedPath = "";
  cachedMtimeMs = 0;
  cachedReadAt = 0;
  cachedQuotas = null;
  lastGoodAt = null;
  loadStatus = { configured: false, ok: true, path: "", cause: null, detail: null };
  reportedSignature = "";
}
