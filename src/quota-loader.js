/**
 * Automatic Magpie `quotas.json` Discovery & Mtime-Cached Loader for Bun (`magpie.hooks` & `/v1/systemone`)
 *
 * Uses the exact same Magpie config directory discovery order as `magpie-community/plugins/packages/mail-watch/paths.js`:
 * 1. Explicit `options.quotas` object/array (returned immediately)
 * 2. Explicit `options.quotaFile` or `process.env.AGENTCOMPASS_QUOTAS_FILE`
 * 3. `options.magpieConfigDir` or `process.env.MAGPIE_CONFIG_DIR`
 * 4. Walking up from the plugin directory looking for Magpie markers (`quotas.json`, `usage.jsonl`, `providers.json`, `plugins.json`)
 * 5. `$XDG_CONFIG_HOME/magpie/quotas.json`, `~/.config/magpie/quotas.json`, `%APPDATA%/magpie/quotas.json`
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAGPIE_MARKERS = ["quotas.json", "usage.jsonl", "providers.json", "plugins.json"];
const CACHE_TTL_MS = 5000;

let cachedPath = "";
let cachedMtimeMs = 0;
let cachedReadAt = 0;
let cachedQuotas = null;

function looksLikeMagpieConfigDir(dir) {
  if (!dir) return false;
  try {
    return MAGPIE_MARKERS.some((marker) => existsSync(join(dir, marker)));
  } catch {
    return false;
  }
}

/**
 * Resolve the path to Magpie's `quotas.json` file if it exists on disk.
 */
export function resolveMagpieQuotasFile(options = {}) {
  if (typeof options.quotaFile === "string" && options.quotaFile.trim()) {
    return options.quotaFile.trim();
  }
  const envQuotaFile = globalThis.process?.env?.AGENTCOMPASS_QUOTAS_FILE;
  if (typeof envQuotaFile === "string" && envQuotaFile.trim()) {
    return envQuotaFile.trim();
  }

  const explicitDir =
    options.magpieConfigDir || globalThis.process?.env?.MAGPIE_CONFIG_DIR;
  if (typeof explicitDir === "string" && explicitDir.trim()) {
    const dir = explicitDir.trim();
    const candidate = join(dir, "quotas.json");
    if (existsSync(candidate)) return candidate;
    const nested = join(dir, "magpie", "quotas.json");
    if (existsSync(nested)) return nested;
    return candidate;
  }

  // Walk up from plugin directory (`<magpieConfigDir>/plugins/node_modules/agentcompass/src`)
  try {
    let cur = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 7; i++) {
      const parent = resolve(cur, "..");
      if (parent === cur) break;
      if (looksLikeMagpieConfigDir(parent)) {
        const qPath = join(parent, "quotas.json");
        if (existsSync(qPath)) return qPath;
      }
      cur = parent;
    }
  } catch {
    // Ignore URL resolution errors
  }

  if (options.autoDiscoverQuotas !== true) {
    return "";
  }

  const home = homedir();
  const xdg = globalThis.process?.env?.XDG_CONFIG_HOME || join(home, ".config");
  const appData = globalThis.process?.env?.APPDATA;
  const standardDirs = [
    join(xdg, "magpie"),
    ...(appData ? [join(appData, "magpie")] : []),
    join(home, ".magpie"),
  ];

  for (const dir of standardDirs) {
    const qPath = join(dir, "quotas.json");
    if (existsSync(qPath)) return qPath;
  }

  return "";
}

/**
 * Load Magpie's live subscription quotas from `options.quotas` or `quotas.json` (with a 5s mtime cache).
 */
export function loadLiveQuotas(options = {}, nowMs = Date.now()) {
  if (options.quotas && typeof options.quotas === "object") {
    return options.quotas;
  }
  if (options.disableQuotas === true) {
    return null;
  }

  const qPath = resolveMagpieQuotasFile(options);
  if (!qPath) return null;

  if (
    cachedQuotas &&
    cachedPath === qPath &&
    nowMs - cachedReadAt < CACHE_TTL_MS
  ) {
    return cachedQuotas;
  }

  try {
    if (!existsSync(qPath)) return null;
    const st = statSync(qPath);
    if (cachedQuotas && cachedPath === qPath && st.mtimeMs === cachedMtimeMs) {
      cachedReadAt = nowMs;
      return cachedQuotas;
    }
    const rawText = readFileSync(qPath, "utf8");
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object") {
      cachedPath = qPath;
      cachedMtimeMs = st.mtimeMs;
      cachedReadAt = nowMs;
      cachedQuotas = parsed;
      return parsed;
    }
  } catch {
    // Non-fatal if quotas.json is being written concurrently
  }

  return null;
}

export function clearQuotasCache() {
  cachedPath = "";
  cachedMtimeMs = 0;
  cachedReadAt = 0;
  cachedQuotas = null;
}
