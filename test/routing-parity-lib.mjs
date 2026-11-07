/**
 * Routes a row of the AgentCompass parity grid (fixtures/gen_routing_parity.py) with the JS port and names why it differs.
 */
import { rankCandidates } from "../src/allocator.js";
import { CANONICAL_ROUTES, canonicalModel, healthKey, resolveModel } from "../src/catalog.js";
import { MAGPIE_MODELS } from "../scripts/catalog-overlay.mjs";

export function routeRow(fixture, row) {
  const [poolRef, subset, profileIndex, realtime, pin] = row;
  const models = poolRef < fixture.spellings.length ? [fixture.spellings[poolRef]] : fixture.pools[poolRef - fixture.spellings.length];
  const efforts = fixture.effort_subsets[subset];
  const candidateModels = models.flatMap((model) =>
    efforts.map((effort) => ({
      id: `${model}:${effort}`,
      provider: fixture.providers[model],
      account: fixture.providers[model],
      model,
      effort,
    })),
  );
  const options = { candidateModels, realtime_loop: Boolean(realtime), unavailable: ["dot_text"] };
  const mode = fixture.pin_modes[pin];
  if (mode === "model") options.constraintModel = models[0];
  if (mode === "model+effort") Object.assign(options, { constraintModel: models[0], constraintEffort: efforts[0] });
  if (mode === "model:effort") options.constraintModel = `${models[0]}:${efforts[0]}`;
  const ranked = rankCandidates(fixture.profiles[profileIndex], options);
  const top = ranked.selected;
  return { models, efforts, mode, ranked, result: top ? [top.model, top.effort, top.score] : null };
}

export const REASONS = {
  tie: "tie: the same score on both sides; each keeps its pool's order, and AgentCompass walks its rows by account",
  thinkingOff: "listed: an effort that turns thinking off costs ability here; AgentCompass scores `none` at the High tier when the model has no curve for it",
  magpieRow: "listed: a model row only Magpie has (Spark); AgentCompass scores it as unmeasured",
  specialist: "listed: a specialist route with no specialist in the pool stays open in a gateway; AgentCompass excludes everything",
  familyPin: "listed: a pin names its own model's rows, a family row being another model (contract R1); AgentCompass at this commit lets the family row answer to it",
};

/**
 * `reason: null` when both sides route alike; otherwise why the row may differ, or `"unexplained"`.
 */
export function classifyRow(fixture, row) {
  const py = row[5];
  const { models, mode, ranked, result: js } = routeRow(fixture, row);
  const realtime = Boolean(row[3]);
  const same = py && js ? py[0] === js[0] && py[1] === js[1] : !py && !js;
  if (same) return { reason: null, js, py, ranked };
  const route = CANONICAL_ROUTES[ranked.task.kind] || {};
  const named = (route.preferred || []).map((m) => canonicalModel(m));
  // Scores differ by a constant (AgentCompass's unknown capacity penalty, which has no quota source here), so compare inside JS.
  const pyRow = py && ranked.allCandidates.find((c) => c.eligible && c.model === py[0] && c.effort === py[1]);
  let reason = "unexplained";
  // Checked first: a pin on models[0], and the other side went to a family row of it.
  if (mode !== "none" && py && py[0] !== models[0] && resolveModel(py[0]).source === "family" && healthKey(py[0]) !== healthKey(models[0]) && canonicalModel(py[0]) === canonicalModel(models[0])) reason = REASONS.familyPin;
  else if (route.restrict_models && !models.some((m) => named.includes(canonicalModel(m)))) reason = REASONS.specialist;
  else if (models.some((m) => resolveModel(m).key in MAGPIE_MODELS)) reason = REASONS.magpieRow;
  else if (realtime && py && ["none", "off", "minimal"].includes(py[1])) reason = REASONS.thinkingOff;
  else if (js && pyRow && Math.abs(pyRow.score - js[2]) < 0.00015) reason = REASONS.tie;
  return { reason, js, py, ranked };
}
