/**
 * What Magpie keeps of its own on top of AgentCompass's `accounts.json` when `sync-catalog.mjs` generates `src/catalog.js`.
 * Nothing here overrides a value AgentCompass calibrates: tier, coding, capabilities, curves and `preferred` all come from
 * `accounts.json`.
 */

// Per-model fields accounts.json has no column for. `efforts`: what a bare name expands to (AgentCompass lists bundles
// instead). `disabled_by_default`: stays out of the default pool until named. A row added upstream and not listed here
// gets NEW_MODEL_DEFAULTS.
export const MODEL_OVERLAY = {
  "deepseek-v4.1-flash-free": {
    "efforts": ["low", "high", "max"],
    "disabled_by_default": true,
    "context_window": 64000
  },
  "claude-fable-5-1": {
    "efforts": ["low", "medium", "high", "xhigh", "max"],
    "disabled_by_default": true,
    "context_window": 200000
  },
  "claude-opus-5-5": {
    "efforts": ["low", "medium", "high", "xhigh", "max"],
    "context_window": 200000
  },
  "gpt-6.1-sol": {
    "efforts": ["low", "medium", "high", "xhigh", "max"],
    "context_window": 400000
  },
  "gpt-6-astra": {
    "efforts": ["low", "medium", "high", "xhigh", "max"],
    "context_window": 400000
  },
  "gemini-4-argon-high": {
    "efforts": ["low", "medium", "high"],
    "context_window": 1000000
  },
  "claude-sonnet-5-5": {
    "efforts": ["low", "medium", "high", "xhigh", "max"],
    "context_window": 200000
  },
  "grok-4.7": {
    "efforts": ["low", "high", "xhigh"],
    "context_window": 131072
  },
  "gemini-3.8-flash-high": {
    "efforts": ["medium", "high"],
    "context_window": 1000000
  },
  "grok-bot": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "dot": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "gpt-6-pro": {
    "efforts": ["max"],
    "disabled_by_default": true
  },
  "claude-haiku-5-5": {
    "efforts": ["low", "medium", "high"],
    "context_window": 200000
  },
  "gpt-6.1-terra": {
    "efforts": ["high"]
  },
  "gpt-6-sol": {
    "efforts": ["high"]
  },
  "gpt-6-luna": {
    "efforts": ["low", "medium", "high"]
  },
  "gpt-5.6-sol": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "gpt-5.6-terra": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "gpt-5.6-luna": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "grok-4.7-build-fast": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "deepseek-v4-pro": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "glm-5.3": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "glm-5.3-flash-free": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "qwen3-coder-next": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "qwen3.8-max": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "kimi-k3.1-pro": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "kimi-k3": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "minimax-m3": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "minimax-m3.1-flash": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "doubao-seed-2-1-pro-260628": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "mimo-v2.6-pro": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "mimo-v2.6-flash-free": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "nemotron-3-ultra-free": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "nemotron-3.5-super-vl-free": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "nemotron-3.5-lightning-free": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "mistral-large-4": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "muse-wonder-1.0": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "beam-free": {
    "efforts": ["high"],
    "disabled_by_default": true
  },
  "flint-40b-free": {
    "efforts": ["high"],
    "disabled_by_default": true
  }
};

export const NEW_MODEL_DEFAULTS = { disabled_by_default: true };

// Rows only Magpie has. Spark: AgentCompass has no row for it yet (docs/RESEARCH_AND_SCHEME.md).
export const MAGPIE_MODELS = {
  "gpt-5.3-codex-spark": {
    "basis": "Not in AgentCompass accounts.json and never benchmarked there: every value is a conservative placeholder, none above gpt-6-luna, so a name holding \"codex\" stops being scored as gpt-6.1-sol. No responsiveness: realtime routing uses the 0.52 default, as AgentCompass does for this name. Only used when a pool names it.",
    "disabled_by_default": true,
    "tier": 3,
    "cost": 1,
    "visual": 0,
    "usd_per_hour": 0.8,
    "context_window": 128000,
    "efforts": ["low", "medium", "high"],
    "capabilities": {
      "reasoning": 0.5,
      "coding": 0.6,
      "exploration": 0.5,
      "anti_hallucination": 0.5,
      "visual": 0,
      "gui": 0
    },
    "subjective": {
      "divergence": 0.3,
      "global_rigor": 0.3,
      "module_precision": 0.6
    }
  }
};

// The classifier prompt reads `scope`; AgentCompass words it for its own dispatch (packets, "this machine", Dot).
export const ROUTE_TEXT = {
  "general_implementation": {
    "scope": "Implement an agreed plan, maintain production features, refactor bounded code or deliver ordinary repository changes.",
    "role": "worker"
  },
  "frontend_implementation": {
    "scope": "Write UI components, interactions, animations and styling from the accepted design; visual evidence inspection is a separate visual_analysis task when material.",
    "role": "worker"
  },
  "debug_review": {
    "scope": "Subtle bug diagnosis, regression analysis, review of code and diffs, invariants, test-driven repairs and checking existing behavior.",
    "role": "reviewer or debugging worker"
  },
  "complex_build_plan": {
    "scope": "Turn an agreed direction into a repository-grounded multi-system build plan: dependencies, interfaces, staged migrations, sequencing, validation and rollback.",
    "role": "planner"
  },
  "direction_reasoning": {
    "scope": "Deep reasoning and discussion of solution direction, competing architectures, assumptions, causal explanations, or which problem to solve.",
    "role": "advisor or scheme designer"
  },
  "exploration_analysis": {
    "scope": "Explore and analyze material in the codebase or dataset and return findings as text: map how a system works, trace where and why something happens, read logs, configs, or documents.",
    "role": "explorer or analyst"
  },
  "research_packet": {
    "scope": "Run a defined quantitative experiment, evaluation benchmark, simulation, backtest or data analysis pipeline, compare variants against a baseline, and report metrics.",
    "role": "research worker"
  },
  "self_contained_code": {
    "scope": "Self-contained code and validation work whose whole input fits in the prompt and whose deliverable is new files with unit tests or an isolated algorithm.",
    "role": "worker"
  },
  "visual_analysis": {
    "scope": "Interpret screenshots, charts, diagrams, spatial layouts, image evidence or visual discrepancies; distinct from writing frontend code.",
    "role": "visual analyst"
  },
  "computer_use": {
    "scope": "Operate a graphical computer or app through screenshots, mouse and keyboard (computer use): GUI-only applications, desktop or browser flows.",
    "role": "computer-use worker"
  },
  "bounded_bulk_work": {
    "scope": "Homogeneous small changes, independent extraction or inventory, boilerplate and fixed transformations with explicit acceptance.",
    "role": "bounded leaf worker"
  },
  "tool_execution": {
    "scope": "A bounded outcome primarily requiring file, shell, browser, API or other tool calls, with direction and authorized actions already established.",
    "role": "tool-execution worker"
  },
  "text_in_text_out": {
    "scope": "Self-contained work whose deliverable is text: drafting, rewriting, translating, summarizing, critiquing, comparing, explaining.",
    "role": "worker"
  },
  "web_research": {
    "scope": "Gather, check and organize information from the open web or public documentation: vendor surveys, current specs, changelog lookups, fact-checks, comparison tables.",
    "role": "worker"
  },
  "dot_execution": {
    "scope": "A bounded assignment an isolated remote worker can finish end to end and return as a completed text deliverable.",
    "role": "worker"
  },
  "other_or_mixed": {
    "scope": "Unmatched or mixed work.",
    "role": "worker"
  }
};

// Scores for efforts accounts.json has no row for, below its lowest.
export const POLICY_OVERLAY = {
  "effort_ability": {
    "none": -1.1,
    "off": -1.1,
    "minimal": -1
  }
};

// Contract R2: `pi` has its own dispatch table. AgentCompass does not ship one at the pinned commit; pi runs the codex
// models, so this is the codex table until it does. An upstream `pi` row wins.
