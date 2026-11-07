/**
 * The AgentCompass commit this repo's catalog and cross-repo tests are pinned to. Everything read from AgentCompass goes
 * through `git show <commit>:<path>`, never its working tree, which may hold another session's uncommitted changes.
 * Override with `MAGPIE_AGENTCOMPASS_REPO` / `MAGPIE_AGENTCOMPASS_COMMIT`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PIN = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../test/fixtures/agentcompass-pin.json", import.meta.url)), "utf8"));

export const AGENTCOMPASS_REPO = process.env.MAGPIE_AGENTCOMPASS_REPO || PIN.repo;
export const AGENTCOMPASS_COMMIT = process.env.MAGPIE_AGENTCOMPASS_COMMIT || PIN.commit;

export function agentCompassFile(relativePath) {
  return execFileSync("git", ["-C", AGENTCOMPASS_REPO, "show", `${AGENTCOMPASS_COMMIT}:${relativePath}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function agentCompassJson(relativePath) {
  return JSON.parse(agentCompassFile(relativePath).replace(/^\uFEFF/, ""));
}

/** Whether the pinned commit can be read here (a checkout without the AgentCompass repo cannot). */
export function agentCompassAvailable() {
  try {
    execFileSync("git", ["-C", AGENTCOMPASS_REPO, "cat-file", "-e", `${AGENTCOMPASS_COMMIT}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
