// Plan sizing and account state (CONTRACT Q3/Q4): capacity follows the plan, an account that is expired,
// signed out, disabled or failing for too long is never selected, and every non-ready account is listed.
import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateModelQuota,
  formatQuotaAccountList,
  healthOnlyQuotas,
  listQuotaAccounts,
  normalizeQuotaSnapshot,
  selectBestRoute,
} from "../src/index.js";
import { handleSystemOneRequest } from "../src/index.js";
import { ACCOUNT_STATES, DEFAULT_USAGE_MAX_AGE_HOURS } from "../src/quota.js";

const T0 = 1_700_000_000_000;
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const win = (over = {}) => ({ name: "7d", remaining: 80, used: 20, resetHours: 100, ...over });
const acct = (over = {}) => ({ kind: "subscription", quota: { windows: [win()] }, ...over });
const ask = (rawQuotas, model = "gpt-5.3-codex", extra = {}) =>
  evaluateModelQuota(model, "high", { hours: 1 }, rawQuotas, {}, T0 + (extra.later ?? 0));

const cap = (provider, plan, windowName = "7d", hours) => {
  const snap = normalizeQuotaSnapshot(
    { [`${provider}/a`]: acct({ plan, quota: { windows: [win({ name: windowName, hours })] } }) },
    T0
  );
  return snap[0].windows[0].capacityUsd;
};

const implProfile = {
  work_kind: "general_implementation",
  reasoning_depth: 2,
  code_complexity: 2,
  context_scale: 2,
  divergence: 1,
  hallucination_risk: 2,
  error_cost: 2,
  needs_visual: false,
  needs_gui: false,
  local_only: true,
  interaction_style: "engineering",
  expected_hours: 1,
};

test("Q4 capacity follows the plan, not one number per provider", () => {
  assert.equal(cap("codex", "plus"), 67);
  assert.equal(cap("codex", "prolite"), 175);
  assert.equal(cap("codex", "pro"), 325);
  assert.equal(cap("claude", "pro"), 156);
  assert.equal(cap("claude", "max5"), 1400);
  assert.equal(cap("claude", "max20"), 2380);
  assert.equal(cap("claude", "max20", "weekly_fable"), 1190);
});

test("Q4 plans match exactly: aliases map, look-alike names do not", () => {
  assert.equal(cap("codex", "Pro Lite"), 175);
  assert.equal(cap("claude", "max_20x"), 2380);
  // `prolite` contains `pro`, `max20-team` contains `max20`: neither may be read as the larger plan.
  assert.equal(normalizeQuotaSnapshot({ "codex/a": acct({ plan: "prolite-beta" }) }, T0)[0].planKnown, false);
  assert.equal(normalizeQuotaSnapshot({ "claude/a": acct({ plan: "max20-team" }) }, T0)[0].planKnown, false);
});

test("Q4 an unknown or unreported plan is sized as the smallest known plan, with a warning", () => {
  for (const plan of ["enterprise", "go", undefined, null]) {
    const [e] = normalizeQuotaSnapshot({ "codex/a": acct({ plan }) }, T0);
    assert.equal(e.windows[0].capacityUsd, 67, `plan=${plan}`);
    assert.equal(e.planKnown, false);
    assert.match(e.warnings.join("\n"), /codex\/a: plan .*smallest known codex plan/);
    assert.equal(e.state, ACCOUNT_STATES.READY, "an unknown plan is still dispatchable");
  }
  const [claude] = normalizeQuotaSnapshot({ "claude/a": acct({ plan: "team" }) }, T0);
  assert.equal(claude.windows[0].capacityUsd, 156);
  assert.equal(claude.windows[0].capacityUsd < 220, true);
});

test("Q4 an explicit capacity_usd still wins over the plan table", () => {
  const [e] = normalizeQuotaSnapshot(
    { "codex/a": acct({ plan: "plus", quota: { windows: [win({ capacity_usd: 999 })] } }) },
    T0
  );
  assert.equal(e.windows[0].capacityUsd, 999);
});

test("Q4 a Plus 5h window is priced with Plus's own size and gates at the small-window floor", () => {
  const five = (plan, remaining) =>
    ask({
      "codex/a": acct({
        plan,
        quota: { windows: [win(), win({ name: "five_hour", remaining, used: 100 - remaining, resetHours: 2 })] },
      }),
    });
  // 20% left of a $13 window is below the 25% small-window floor; the same 20% of a Pro window is not.
  assert.equal(five("plus", 20).eligible, false);
  assert.equal(five("pro", 20).eligible, true);
});

test("Q4 rates measured under another plan are not carried over after a tier change", () => {
  const w = win({ pct_per_hour_24h: 0.46, pct_per_hour_3h: 0 });
  const kept = normalizeQuotaSnapshot({ "codex/a": acct({ plan: "pro", rate_plan: "pro", quota: { windows: [w] } }) }, T0);
  const dropped = normalizeQuotaSnapshot({ "codex/a": acct({ plan: "plus", rate_plan: "pro", quota: { windows: [w] } }) }, T0);
  assert.equal(kept[0].windows[0].pctPerHour24h, 0.46);
  assert.equal(dropped[0].windows[0].pctPerHour24h, null);
});

test("Q2 a credential claim that disagrees with the online plan warns, and the online plan sizes capacity", () => {
  const [e] = normalizeQuotaSnapshot({ "codex/a": acct({ plan: "plus", plan_claim: "pro" }) }, T0);
  assert.equal(e.windows[0].capacityUsd, 67);
  assert.match(e.warnings.join("\n"), /plan sources disagree/);
});

for (const [label, item, state] of [
  ["status expired", { status: "expired" }, "plan_inactive"],
  ["status cancelled", { status: "cancelled" }, "plan_inactive"],
  ["free plan", { plan: "free" }, "plan_inactive"],
  ["payment failed plan", { plan: "payment_failed" }, "plan_inactive"],
  ["HTTP 401", { error: { status: 401, message: "x" } }, "auth_failed"],
  ["HTTP 403 field", { http_status: 403 }, "auth_failed"],
  ["disabled flag", { disabled: true }, "disabled"],
  ["error with no known last success", { error: "boom" }, "usage_failing"],
  ["status error", { status: "error" }, "usage_failing"],
]) {
  test(`Q3 ${label} is excluded from selection, with its state and reason`, () => {
    const q = { "codex/a": acct({ plan: "plus", ...item }) };
    const r = ask(q);
    assert.equal(r.eligible, false);
    assert.match(r.excluded.join("\n"), new RegExp(`codex/a: ${state}`));
    const [row] = listQuotaAccounts(q, T0);
    assert.equal(row.state, state);
    assert.equal(row.dispatchable, false);
    assert.ok(row.reason);
  });
}

test("Q3 an invalid account plus an exhausted one: nothing is selected, the invalid one is not rescued", () => {
  const q = {
    "codex/expired": acct({ plan: "plus", status: "expired", quota: { windows: [win({ remaining: 95, used: 5 })] } }),
    "codex/low": acct({ plan: "plus", quota: { windows: [win({ remaining: 3, used: 97 })] } }),
  };
  const r = ask(q);
  assert.equal(r.eligible, false, "the expired account must not be picked just because the other is exhausted");
});

test("Q3 a healthy account is selected over an invalid one with more quota", () => {
  const q = {
    "codex/expired": acct({ plan: "plus", status: "expired", quota: { windows: [win({ remaining: 99, used: 1 })] } }),
    "codex/ok": acct({ plan: "plus", quota: { windows: [win({ remaining: 40, used: 60 })] } }),
  };
  const r = ask(q);
  assert.equal(r.eligible, true);
  assert.equal(r.account, "codex/ok");
  assert.match(r.warnings.join("\n"), /codex\/expired: plan_inactive/, "the unselected failing account is still reported");
});

test("Q3 usage_failing warns at once, keeps dispatching for 6h, then excludes", () => {
  const lastOk = T0 - 2 * HOUR;
  const q = { "codex/a": acct({ plan: "plus", error: "upstream 500", last_success_at: iso(lastOk) }) };

  const soon = ask(q);
  assert.equal(soon.eligible, true);
  assert.match(soon.warnings.join("\n"), /codex\/a: usage_failing: usage reading failing: upstream 500 \(last success 2023-11-14T20:13:20\.000Z\)/);
  const [row] = listQuotaAccounts(q, T0);
  assert.equal(row.state, "usage_failing");
  assert.equal(row.dispatchable, true);
  assert.equal(row.last_success_at, iso(lastOk));

  assert.equal(DEFAULT_USAGE_MAX_AGE_HOURS, 6);
  const later = ask(q, "gpt-5.3-codex", { later: 5 * HOUR });
  assert.equal(later.eligible, false, "7h without a successful reading");
  assert.match(later.excluded.join("\n"), /usage_failing/);
});

test("Q3 the 6h limit is configurable", () => {
  const lastOk = T0 - 2 * HOUR;
  const base = { "codex/a": acct({ plan: "plus", error: "x", last_success_at: iso(lastOk) }) };
  assert.equal(ask({ ...base, usage_max_age_hours: 1 }).eligible, false);
  assert.equal(ask({ ...base, usage_max_age_hours: 12 }, "gpt-5.3-codex", { later: 5 * HOUR }).eligible, true);
  const viaPolicy = normalizeQuotaSnapshot(base, T0, { usage_max_age_hours: 1 });
  assert.equal(viaPolicy[0].excluded, true);
  const viaOpts = normalizeQuotaSnapshot(base, T0, {}, { usageMaxAgeHours: 1 });
  assert.equal(viaOpts[0].excluded, true);
});

test("Q3 a reading that is simply old counts as failing even without an error", () => {
  const q = { "codex/a": acct({ plan: "plus", fetched_at: iso(T0 - 10 * 24 * HOUR) }) };
  const r = ask(q);
  assert.equal(r.eligible, false);
  const [row] = listQuotaAccounts(q, T0);
  assert.equal(row.state, "usage_failing");
  assert.match(row.reason, /no successful reading for 240\.0h/);
});

test("Q3 an account with no usable reading at all is usage_failing, not silently ready", () => {
  const q = { "codex/a": { kind: "subscription", plan: "plus", quota: { windows: [] } } };
  const [row] = listQuotaAccounts(q, T0);
  assert.equal(row.state, "usage_failing");
  assert.equal(row.last_success_at, null);
  assert.equal(ask(q).eligible, false);
});

test("Q3 a recovered reading returns the account to ready by itself", () => {
  const failing = { "codex/a": acct({ plan: "plus", error: "x", last_success_at: iso(T0 - 8 * HOUR) }) };
  assert.equal(ask(failing).eligible, false);
  const recovered = { "codex/a": acct({ plan: "plus", fetched_at: iso(T0 - 60_000) }) };
  const r = ask(recovered);
  assert.equal(r.eligible, true);
  assert.equal(listQuotaAccounts(recovered, T0)[0].state, "ready");
  assert.deepEqual(r.warnings, []);
});

test("Q3 state is read from structured fields: error text alone never means auth_failed", () => {
  const q = { "codex/a": acct({ plan: "plus", error: "401 Unauthorized", last_success_at: iso(T0 - HOUR) }) };
  assert.equal(listQuotaAccounts(q, T0)[0].state, "usage_failing");
});

test("Q3 state names match AgentCompass", () => {
  assert.deepEqual(
    [ACCOUNT_STATES.READY, ACCOUNT_STATES.PLAN_INACTIVE, ACCOUNT_STATES.USAGE_FAILING, ACCOUNT_STATES.AUTH_FAILED],
    ["ready", "plan_inactive", "usage_failing", "auth_failed"]
  );
});

test("Q3 the account list shows state, reason and last successful reading, in data and text", () => {
  const q = {
    "codex/ok": acct({ plan: "plus", fetched_at: iso(T0 - 60_000) }),
    "claude/out": acct({ plan: "max5", error: "rate", last_success_at: iso(T0 - HOUR) }),
    "claude/dead": acct({ plan: "free" }),
  };
  const rows = listQuotaAccounts(q, T0);
  assert.deepEqual(
    rows.map((r) => [r.key, r.state, r.dispatchable]),
    [
      ["codex/ok", "ready", true],
      ["claude/out", "usage_failing", true],
      ["claude/dead", "plan_inactive", false],
    ]
  );
  const text = formatQuotaAccountList(rows);
  assert.match(text, /claude\/out .*state=usage_failing .*last_success=2023-11-14T21:13:20\.000Z - usage reading failing: rate/);
  assert.match(text, /claude\/dead .*state=plan_inactive \[excluded from dispatch\] .*last_success=never/);
});

test("Q3 plan() output carries the account list and its warnings, selected or not", () => {
  const quotas = {
    "claude/out": acct({ plan: "max5", error: "rate", last_success_at: iso(T0 - HOUR) }),
    "claude/ok": acct({ plan: "max5", fetched_at: iso(T0 - 60_000) }),
  };
  const d = selectBestRoute(implProfile, { candidateModels: ["claude-sonnet-4-6"], now: T0, quotas });
  assert.equal(d.ok, true);
  assert.equal(d.selectedAccount, "claude/ok");
  assert.deepEqual(d.accounts.map((a) => a.state), ["usage_failing", "ready"]);
  assert.ok(d.warnings.some((w) => w.startsWith("claude/out: usage_failing")));
});

test("Q3 a route whose only account is invalid is not rescued by the no-quota fallback", () => {
  const quotas = { "claude/dead": acct({ plan: "max5", status: "expired" }) };
  const primary = selectBestRoute(implProfile, { candidateModels: ["claude-sonnet-4-6"], now: T0, quotas });
  assert.equal(primary.ok, false);
  const fallback = selectBestRoute(implProfile, {
    candidateModels: ["claude-sonnet-4-6"],
    now: T0,
    quotas: healthOnlyQuotas(quotas, T0),
  });
  assert.equal(fallback.ok, false, "expired stays excluded in the fallback");
  assert.ok(fallback.warnings.some((w) => /claude\/dead: plan_inactive, excluded from dispatch/.test(w)));
});

test("Q3 the fallback still ignores exhausted windows on a healthy account", () => {
  const quotas = { "claude/low": acct({ plan: "max5", quota: { windows: [win({ remaining: 2, used: 98 })] } }) };
  const opts = { candidateModels: ["claude-sonnet-4-6"], now: T0 };
  assert.equal(selectBestRoute(implProfile, { ...opts, quotas }).ok, false);
  assert.equal(selectBestRoute(implProfile, { ...opts, quotas: healthOnlyQuotas(quotas, T0) }).ok, true);
});

test("Q3 the decision provider response lists accounts and warnings", async () => {
  const quotas = { "claude/dead": acct({ plan: "max5", status: "expired" }), "codex/ok": acct({ plan: "plus" }) };
  const out = await handleSystemOneRequest(
    {
      model: "agentcompass-systemone",
      state: { task: "Refactor the parser and add tests.", quotas },
      questions: { work_kind: { choices: ["general_implementation"] } },
    },
    { candidateModels: ["gpt-5.3-codex", "claude-sonnet-4-6"] }
  );
  const ac = out.agentcompass;
  assert.deepEqual(ac.accounts.map((a) => [a.key, a.state]), [["claude/dead", "plan_inactive"], ["codex/ok", "ready"]]);
  assert.ok(ac.warnings.some((w) => w.startsWith("claude/dead: plan_inactive")));
  assert.equal(ac.selectedAccount === "claude/dead", false);
});
