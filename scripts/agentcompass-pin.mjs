/**
 * The AgentCompass commit this repo's catalog, reference data and cross-repo tests are pinned to
 * (`test/fixtures/agentcompass-pin.json` holds the commit and nothing else). Everything read from AgentCompass goes
 * through `git show <commit>:<path>`, never its working tree, which may hold another session's uncommitted changes.
 *
 * Where the AgentCompass checkout is belongs to the machine, not to this repository: give it with the environment
 * variable `MAGPIE_AGENTCOMPASS_REPO` (a git checkout or bare clone), or with `--agentcompass-repo <path>` on a script's
 * command line. `MAGPIE_AGENTCOMPASS_COMMIT` reads another commit for a trial run.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PIN = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../test/fixtures/agentcompass-pin.json", import.meta.url)), "utf8"));

export const AGENTCOMPASS_COMMIT = process.env.MAGPIE_AGENTCOMPASS_COMMIT || PIN.commit;

function repoFromArgv(argv = process.argv) {
  const at = argv.indexOf("--agentcompass-repo");
  if (at >= 0 && argv[at + 1]) return argv[at + 1];
  const inline = argv.find((arg) => arg.startsWith("--agentcompass-repo="));
  return inline ? inline.slice("--agentcompass-repo=".length) : "";
}

/** The AgentCompass checkout on this machine, or `""` when none was given. */
export function agentCompassRepo() {
  return repoFromArgv() || process.env.MAGPIE_AGENTCOMPASS_REPO || "";
}

function requireRepo() {
  const repo = agentCompassRepo();
  if (!repo) {
    throw new Error(
      "no AgentCompass checkout given: set MAGPIE_AGENTCOMPASS_REPO to a git checkout of AgentCompass, or pass --agentcompass-repo <path>",
    );
  }
  return repo;
}

export function agentCompassFile(relativePath) {
  return execFileSync("git", ["-C", requireRepo(), "show", `${AGENTCOMPASS_COMMIT}:${relativePath}`], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function agentCompassJson(relativePath) {
  return JSON.parse(agentCompassFile(relativePath).replace(/^﻿/, ""));
}

/** Whether the pinned commit can be read here (no checkout given, or one without the commit, cannot). */
export function agentCompassAvailable() {
  const repo = agentCompassRepo();
  if (!repo) return false;
  try {
    execFileSync("git", ["-C", repo, "cat-file", "-e", `${AGENTCOMPASS_COMMIT}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
