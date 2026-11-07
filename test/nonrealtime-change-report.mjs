/**
 * How non-realtime routing changed against an earlier commit, by class: the numbers in docs/RESEARCH_AND_SCHEME.md section 4.6.
 *
 *     node test/nonrealtime-change-report.mjs [<baseline sha, default ab8baba>]
 *
 * Bare-name pools (fixtures/nonrealtime-pools.json) x the profiles of the parity grid. The classes say what a change looks like,
 * from the pool and the outcome; they do not isolate a cause.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rankCandidates } from "../src/allocator.js";
import { RETIRED_NAMES, resolveModel } from "../src/catalog.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const baseline = process.argv[2] || "ab8baba";
const pools = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "nonrealtime-pools.json"), "utf8"));
const { profiles } = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "agentcompass-routing-parity.json"), "utf8"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-baseline-"));
const archive = path.join(work, "src.tar");
execFileSync("git", ["-C", path.dirname(HERE), "archive", "-o", archive, baseline, "src", "package.json"]);
execFileSync("tar", ["-xf", path.basename(archive)], { cwd: work });
const old = await import(pathToFileURL(path.join(work, "src", "allocator.js")).href);

const retired = new Set(Object.values(RETIRED_NAMES).flat());
const notARow = (name) => ["family", "unknown"].includes(resolveModel(name).source);
const label = (c) => (c ? `${c.model}:${c.effort}` : "none");
const classes = new Map();
let same = 0;
for (const pool of pools) {
  for (const profile of profiles) {
    const before = old.rankCandidates(profile, { candidateModels: pool }).selected;
    const now = rankCandidates(profile, { candidateModels: pool }).selected;
    if (label(before) === label(now)) {
      same++;
      continue;
    }
    let name;
    if (pool.some((m) => retired.has(m) && notARow(m))) name = "a retired alias in the pool";
    else if (pool.some(notARow)) name = "a family or unknown name in the pool";
    else if (before && now && before.model === now.model) name = "same model, other effort";
    else if (!before || !now) name = "one side has no route";
    else name = "other model";
    const entry = classes.get(name) || { count: 0, noRouteNow: 0, sample: `[${pool.slice(0, 3)}] ${profile.work_kind}: ${label(before)} -> ${label(now)}` };
    entry.count++;
    if (before && !now) entry.noRouteNow++;
    classes.set(name, entry);
  }
}
fs.rmSync(work, { recursive: true, force: true });

const total = pools.length * profiles.length;
console.log(`${total} rows against ${baseline}: ${same} alike (${((100 * same) / total).toFixed(2)}%)`);
for (const [name, { count, noRouteNow, sample }] of [...classes].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`${count}\t${name} (no route now: ${noRouteNow})\t${sample}`);
}
