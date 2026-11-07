/**
 * Routes the AgentCompass parity grid (fixtures/gen_routing_parity.py) with the JS port. Both sides must pick the same
 * model and effort, and a row where they do not must have a reason in `REASONS`. The committed fixture is a sample; point
 * MAGPIE_ROUTING_PARITY_FIXTURE at a whole grid for the local report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyRow } from "./routing-parity-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  fs.readFileSync(process.env.MAGPIE_ROUTING_PARITY_FIXTURE || path.join(HERE, "fixtures", "agentcompass-routing-parity.json"), "utf8"),
);
const PIN = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "agentcompass-pin.json"), "utf8"));

test("the parity grid comes from the pinned AgentCompass commit", () => {
  assert.equal(FIXTURE.source.commit, process.env.MAGPIE_AGENTCOMPASS_COMMIT || PIN.commit);
  assert.ok(FIXTURE.rows.length > 1000);
});

test("every difference from allocator.py on the parity grid has a named reason", (t) => {
  const byReason = new Map();
  const unexplained = [];
  for (const row of FIXTURE.rows) {
    const { reason, js, py } = classifyRow(FIXTURE, row);
    if (!reason) continue;
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
    if (reason === "unexplained") unexplained.push({ row, js, py });
  }
  const differing = [...byReason.values()].reduce((sum, n) => sum + n, 0);
  const same = FIXTURE.rows.length - differing;
  t.diagnostic(`${same} of ${FIXTURE.rows.length} rows alike (${((100 * same) / FIXTURE.rows.length).toFixed(2)}%)`);
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) t.diagnostic(`${count}: ${reason}`);
  assert.deepEqual(unexplained.slice(0, 5), []);
});
