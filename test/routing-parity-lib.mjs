/**
 * Routes a row of the AgentCompass parity grid (fixtures/gen_routing_parity.py) with the JS port and names why it differs.
 */
import { rankCandidates } from "../src/allocator.js";
import { DIRECT_SOURCES, healthKey, resolveModel, rowKey } from "../src/catalog.js";

export function routeRow(fixture, row) {
  const [poolRef, subset, profileIndex, pin] = row;
  const models = poolRef < fixture.spellings.length ? [fixture.spellings[poolRef]] : fixture.pools[poolRef - fixture.spellings.length];
  const efforts = fixture.effort_subsets[subset];
  const candidateModels = models.flatMap((model) =>
    efforts.map((effort) => ({ id: `${model}:${effort}`, provider: fixture.providers[model], model, effort })),
  );
  const options = { candidateModels, now: Date.parse(fixture.now) };
  const mode = fixture.pin_modes[pin];
  if (mode === "model") options.constraintModel = models[0];
  if (mode === "model+effort") Object.assign(options, { constraintModel: models[0], constraintEffort: efforts[0] });
  if (mode === "model:effort") options.constraintModel = `${models[0]}:${efforts[0]}`;
  const ranked = rankCandidates(fixture.profiles[profileIndex], options);
  const top = ranked.selected;
  return { models, efforts, mode, ranked, result: top ? [top.model, top.effort ?? null, top.score] : null };
}

export const SCORE_TOLERANCE = 1e-9;

export const REASONS = {
  tie: "tie: the same score on both sides; each keeps its pool's order, and AgentCompass walks its rows by account",
  familyPin: "listed: a pin names its own model's rows, a family row being another model (contract R1); AgentCompass at this commit lets the family row answer to it",
};

/**
 * `reason: null` when both sides route alike (same model and effort, scores within `SCORE_TOLERANCE`); otherwise why the row
 * may differ, or `"unexplained"`.
 */
export function classifyRow(fixture, row) {
  const py = row[4];
  const { models, mode, ranked, result: js } = routeRow(fixture, row);
  const same = py && js ? py[0] === js[0] && (py[1] ?? null) === js[1] : !py && !js;
  if (same) {
    if (py && Math.abs(py[2] - js[2]) > SCORE_TOLERANCE) return { reason: "unexplained", js, py, ranked, why: "score" };
    return { reason: null, js, py, ranked };
  }
  let reason = "unexplained";
  const pyRow = py && ranked.allCandidates.find((c) => c.eligible && c.model === py[0] && (c.effort ?? null) === (py[1] ?? null));
  // A pin on models[0], and the other side went to a family row of it.
  if (mode !== "none" && py && py[0] !== models[0] && !DIRECT_SOURCES.includes(resolveModel(py[0]).source) && healthKey(py[0]) !== healthKey(models[0]) && rowKey(py[0]) !== rowKey(models[0])) reason = REASONS.familyPin;
  else if (js && pyRow && Math.abs(pyRow.score - js[2]) < SCORE_TOLERANCE) reason = REASONS.tie;
  return { reason, js, py, ranked };
}
