/**
 * Native Magpie System-One Decision Provider Plugin (`decide: true` / `decides: true`)
 *
 * How Magpie integrates this provider (`internal/gateway/decide.go` & `internal/plugin/host.js:1787,1821`):
 * 1. Registers provider `"agentcompass-router"` with `decide: true` and model
 *    `"agentcompass-systemone"` with `decides: true`.
 * 2. In Magpie's UI (Routing -> Group -> Classifier), the user can select
 *    `agentcompass-router/agentcompass-systemone` as the Routing Group's Classifier.
 * 3. Magpie gives Classifier calls `Settings.ClassifyTimeout`: **8,000 ms default, configurable
 *    up to 60,000 ms (60 seconds)** (`internal/gateway/classify.go:classifyTimeout()`).
 * 4. Handles all three `/v1/systemone` request shapes sent by Magpie:
 *    - Shape A (`jevLevelled` probe in `decide.go:310`): `state.kinds` + `questions.levels` + `questions.work0..N`
 *    - Shape B (`jevBody` turn classification in `decide.go:167`): `state.turn` + `questions.intent` / `questions.level` + `questions.effort`
 *    - Shape C (Direct AgentCompass 10-field `/v1/systemone` query): `state.task` + `questions.work_kind` / `reasoning_depth` / etc.
 */

import { rankCandidates, selectBestRoute } from "./allocator.js";
import { CANONICAL_ROUTES, canonicalModel } from "./catalog.js";
import { scoreTaskLive } from "./scorer-live.js";

export const PROVIDER_ID = "agentcompass-router";
export const DECISION_MODEL_ID = "agentcompass-systemone";

const DIFFICULTY_SCALE_WORDS = {
  routine: 0,
  simple: 0,
  easy: 0,
  trivial: 0,
  low: 0,
  简单: 0,
  日常: 0,
  轻量: 0,
  hard: 1,
  standard: 1,
  medium: 1,
  normal: 1,
  中等: 1,
  常规: 1,
  标准: 1,
  coupled: 2,
  complex: 2,
  deep: 2,
  architectural: 2,
  复杂: 2,
  跨模块: 2,
  架构: 2,
  frontier: 3,
  extreme: 3,
  critical: 3,
  max: 3,
  前沿: 3,
  高难: 3,
  极限: 3,
};

const EFFORT_TO_JEV_SCORE = {
  low: 0.0,
  medium: 1.0,
  high: 2.0,
  xhigh: 3.0,
  max: 3.0,
  ultra: 3.0,
};

/**
 * Check if a Routing Group's `intents` array represents difficulty/scale levels
 * (`jevLevelled` in `internal/gateway/decide.go:310`).
 */
export function evaluateLevelsProbe(kinds = []) {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    return { isLevels: false, scores: [] };
  }
  let matched = 0;
  const scores = kinds.map((raw) => {
    const clean = String(raw || "").trim().toLowerCase();
    for (const [word, score] of Object.entries(DIFFICULTY_SCALE_WORDS)) {
      if (clean === word || clean.includes(word)) {
        matched++;
        return score;
      }
    }
    return 1.0;
  });
  return {
    isLevels: matched === kinds.length && new Set(scores).size >= 2,
    scores,
  };
}

/**
 * Match a profiled AgentCompass task (`workKind`, `difficulty`, `targetModel`, `profile`)
 * against the user's Routing Group `intent` or `level` choices in Magpie (`decide.go:readJev`).
 */
export function matchMagpieIntentChoice(criteriaObj, routeDecision) {
  const choices = Object.keys(criteriaObj || {});
  if (choices.length === 0) {
    return { choice: "none", confidence: 1.0, probabilities: { none: 1.0 } };
  }

  const nonNone = choices.filter((c) => c !== "none");
  const wk = String(routeDecision.workKind || "").toLowerCase();
  const diff = String(routeDecision.difficulty || "hard").toLowerCase();
  const targetCanon = canonicalModel(routeDecision.targetModel || "").toLowerCase();
  const style = String(routeDecision.profile?.interaction_style || "").toLowerCase();

  let bestChoice = null;
  let bestWeight = -1;
  const rawWeights = {};

  for (const candidate of nonNone) {
    const lower = candidate.trim().toLowerCase();
    const desc = String(criteriaObj[candidate] || "").toLowerCase();
    let w = 0.05;

    // 1. Exact or substring match with AgentCompass's 16 canonical `work_kind` routes
    if (lower === wk || lower.replace(/[-\s]/g, "_") === wk) {
      w = 10.0;
    } else if (desc.includes(wk.replace(/_/g, " ")) || lower.includes(wk.split("_")[0])) {
      w = Math.max(w, 6.0);
    }

    // 2. Match by difficulty level (`routine`, `hard`, `coupled`, `frontier`, Chinese equivalents)
    if (lower === diff || (DIFFICULTY_SCALE_WORDS[lower] !== undefined && DIFFICULTY_SCALE_WORDS[lower] === DIFFICULTY_SCALE_WORDS[diff])) {
      w = Math.max(w, 8.5);
    }

    // 3. Match by model family or DNA keywords in the rule's intent label
    if (targetCanon && (lower.includes(targetCanon) || targetCanon.includes(lower))) {
      w = Math.max(w, 8.0);
    }
    if (
      (wk === "frontend_implementation" && /frontend|ui|react|css|前端|界面/.test(lower)) ||
      (wk === "debug_review" && /debug|bug|fix|review|audit|排查|修复|审查|审计/.test(lower)) ||
      ((wk === "direction_reasoning" || wk === "complex_build_plan") && /plan|architect|design|scheme|方案|架构|规划/.test(lower)) ||
      ((wk === "bounded_bulk_work" || wk === "tool_execution") && /fast|quick|routine|bulk|simple|简单|日常|批量|轻量/.test(lower)) ||
      (wk === "visual_analysis" && /vis|image|screenshot|看图|视觉|截图/.test(lower)) ||
      (wk === "computer_use" && /gui|desktop|browser|computer|桌面|点击/.test(lower)) ||
      (style === "exploration" && /explor|research|search|分析|调研|探索/.test(lower)) ||
      (style === "engineering" && /code|coding|implement|dev|代码|开发|实现/.test(lower))
    ) {
      w = Math.max(w, 7.5);
    }

    rawWeights[candidate] = w;
    if (w > bestWeight) {
      bestWeight = w;
      bestChoice = candidate;
    }
  }

  if (!bestChoice || (bestWeight < 1.0 && choices.includes("none"))) {
    bestChoice = choices.includes("none") ? "none" : nonNone[0];
  }

  // Build normalized probability distribution so Magpie's `sureOf` (`decide.go:257`, `jevSure = 0.6`) accepts the choice
  const probabilities = {};
  const winnerProb = 0.88;
  const restChoices = choices.filter((c) => c !== bestChoice);
  const remainder = restChoices.length > 0 ? (1.0 - winnerProb) / restChoices.length : 0.0;
  for (const c of choices) {
    probabilities[c] = c === bestChoice ? (restChoices.length > 0 ? winnerProb : 1.0) : Math.round(remainder * 10000) / 10000;
  }

  return {
    choice: bestChoice,
    confidence: probabilities[bestChoice],
    probabilities,
  };
}

/**
 * Handle a POST `/v1/systemone` request from Magpie (`internal/gateway/decide.go`).
 */
export async function handleSystemOneRequest(bodyObj, pluginOptions = {}) {
  const model = bodyObj?.model || DECISION_MODEL_ID;
  const state = bodyObj?.state || {};
  const questions = bodyObj?.questions || {};

  // Case 1: Magpie `jevLevelled` probe (`state.kinds` + `questions.levels`)
  if ("levels" in questions && Array.isArray(state.kinds)) {
    const { isLevels, scores } = evaluateLevelsProbe(state.kinds);
    const answers = {
      levels: { noul: isLevels ? 0.9 : 0.05 },
    };
    scores.forEach((s, idx) => {
      if (`work${idx}` in questions) {
        answers[`work${idx}`] = { score: s };
      }
    });
    return {
      model,
      answers,
      usage: { input_tokens: 32, output_tokens: 16 },
    };
  }

  // Case 2: Magpie Routing Group per-turn decision (`state.turn` + `questions.intent` / `level` / `effort`)
  const turnText =
    typeof state.turn === "string"
      ? state.turn
      : typeof state.task?.objective === "string"
        ? state.task.objective
        : JSON.stringify(state);

  const taskFacts = {
    objective: turnText,
    previousUser: typeof state.previous_user === "string" ? state.previous_user : "",
    hasVisualInput: Boolean(state.has_visual_input),
  };

  const { profile, meta } = await scoreTaskLive(taskFacts, {
    scorerType: pluginOptions.scorerType || "heuristic",
    scorerModel: pluginOptions.scorerModel,
    scorerBaseUrl: pluginOptions.scorerBaseUrl,
    scorerApiKey: pluginOptions.scorerApiKey,
    jevBaseUrl: pluginOptions.jevBaseUrl,
    jevApiKey: pluginOptions.jevApiKey,
    scorerTimeoutMs: pluginOptions.scorerTimeoutMs || 15000,
    fetch: pluginOptions.fetch,
  });

  const decision = selectBestRoute(profile, {
    objective: turnText,
    candidateModels: pluginOptions.candidateModels,
    catalog: pluginOptions.catalog,
  });

  const answers = {};

  if (questions.intent?.criteria) {
    answers.intent = matchMagpieIntentChoice(questions.intent.criteria, decision);
  }
  if (questions.level?.criteria) {
    answers.level = matchMagpieIntentChoice(questions.level.criteria, decision);
  }
  if (questions.effort) {
    const effScore = EFFORT_TO_JEV_SCORE[decision.targetEffort] ?? 2.0;
    const probs = [0.02, 0.03, 0.03, 0.02];
    const idx = Math.max(0, Math.min(3, Math.round(effScore)));
    probs[idx] = 0.9;
    answers.effort = {
      score: effScore,
      confidence: 0.9,
      probabilities: probs,
    };
  }

  // Case 3: Direct 10-field System-One questions (when called as a general Jev endpoint)
  if (questions.work_kind && !answers.work_kind) {
    answers.work_kind = { choice: decision.workKind, confidence: 0.9 };
  }
  if (questions.interaction_style && !answers.interaction_style) {
    answers.interaction_style = { choice: profile.interaction_style, confidence: 0.9 };
  }
  for (const dim of ["reasoning_depth", "code_complexity", "context_scale", "divergence", "hallucination_risk", "error_cost"]) {
    if (questions[dim] && !answers[dim]) {
      const low = dim === "code_complexity" ? 0 : 1;
      answers[dim] = { score: Math.max(0, (profile[dim] ?? low) - low) };
    }
  }
  for (const flag of ["needs_visual", "needs_gui", "local_only"]) {
    if (questions[flag] && !answers[flag]) {
      answers[flag] = { noul: profile[flag] ? 0.95 : 0.05 };
    }
  }

  return {
    model,
    answers,
    agentcompass: {
      targetModel: decision.targetModel,
      targetEffort: decision.targetEffort,
      workKind: decision.workKind,
      difficulty: decision.difficulty,
      requiredAbility: decision.requiredAbility,
      profile,
      scorer: meta,
    },
    usage: {
      input_tokens: Math.max(16, Math.ceil(turnText.length / 4)),
      output_tokens: 48,
    },
  };
}

/**
 * Default OpenCode / Magpie Provider Plugin export (`src/index.js`).
 */
export async function AgentCompassRouterPlugin(input, pluginOptions = {}) {
  return {
    async config(cfg) {
      cfg.provider = cfg.provider || {};
      cfg.provider[PROVIDER_ID] = {
        name: "AgentCompass Intent Router",
        api: "https://agentcompass.local/v1",
        decide: true,
        models: {
          [DECISION_MODEL_ID]: {
            name: "AgentCompass System-One Profiler (10D + Model DNA)",
            decides: true,
            reasoning: true,
            tool_call: false,
            limit: { context: 200000, output: 4096 },
            cost: { input: 0, output: 0 },
          },
        },
      };
    },
    auth: {
      provider: PROVIDER_ID,
      single: true,
      options: [
        {
          key: "live_scorer",
          label: "Use Live System-One LLM Scorer",
          description: "Call the configured fast LLM or Jev endpoint before falling back to the deterministic profiler.",
          default: false,
          labels: { zh: "启用实时 System-One 评分模型" },
          descriptions: { zh: "优先调用配置的轻量级评分模型或 Jev 接口生成 10 维任务画像，超时自动回退至确定性算法。" },
        },
      ],
      methods: [
        {
          type: "api",
          keyless: true,
          label: "Enable AgentCompass Local Intent Router",
          async authorize() {
            return {
              type: "success",
              key: "agentcompass-local",
              accountId: "agentcompass-core",
            };
          },
        },
      ],
      async loader(_getAuth, _provider) {
        return {
          baseURL: "https://agentcompass.local/v1",
          apiKey: "agentcompass-local",
          async fetch(reqInput, init) {
            const rawBody = init?.body
              ? typeof init.body === "string"
                ? init.body
                : new TextDecoder().decode(init.body)
              : reqInput instanceof Request
                ? await reqInput.text()
                : "{}";
            let parsed = {};
            try {
              parsed = JSON.parse(rawBody);
            } catch {}

            const useLive =
              input?.magpie?.option?.(PROVIDER_ID, "live_scorer") === true ||
              Boolean(pluginOptions.scorerType && pluginOptions.scorerType !== "heuristic");

            const effectiveOpts = {
              ...pluginOptions,
              scorerType: useLive ? pluginOptions.scorerType || "openai_compatible" : "heuristic",
            };

            const reply = await handleSystemOneRequest(parsed, effectiveOpts);
            return new Response(JSON.stringify(reply), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        };
      },
    },
  };
}

export default AgentCompassRouterPlugin;
export { rankCandidates, selectBestRoute };
