"""Regenerate test/fixtures/agentcompass-routing-parity.json from AgentCompass's allocator.py at a pinned commit.

    python -X utf8 test/fixtures/gen_routing_parity.py [--commit <sha>] [--sample N] [--out <path>]

The grid crosses model spellings, effort subsets, realtime or not, how the user pins, and profile boundaries. Both sides get
the same explicit bundles and the same profile; test/routing-parity.test.mjs routes each row with the JS port and classifies
every difference. Without --sample the whole grid is written, for a local report; the committed fixture is a sample of it.
Reads AgentCompass only through `git archive <commit>`, never a working tree.
"""
import argparse
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PIN = json.load(open(os.path.join(HERE, "agentcompass-pin.json"), encoding="utf-8"))

parser = argparse.ArgumentParser()
parser.add_argument("--repo", default=os.environ.get("MAGPIE_AGENTCOMPASS_REPO", PIN["repo"]))
parser.add_argument("--commit", default=os.environ.get("MAGPIE_AGENTCOMPASS_COMMIT", PIN["commit"]))
parser.add_argument("--sample", type=int, default=1)
parser.add_argument("--out", default=os.path.join(HERE, "agentcompass-routing-parity.json"))
args = parser.parse_args()

work = tempfile.mkdtemp(prefix="ac-parity-")
archive = subprocess.run(
    ["git", "-C", args.repo, "archive", "--format=tar", args.commit, "skills/agent-compass"],
    check=True,
    capture_output=True,
).stdout
tarfile.open(fileobj=io.BytesIO(archive)).extractall(work, filter="data")
scripts = os.path.join(work, "skills/agent-compass/scripts")
references = os.path.join(work, "skills/agent-compass/references")
os.environ["ROUTER_LAUNCH_FAILURES"] = "off"
os.environ.setdefault("AGENT_COMPASS_HOME", tempfile.mkdtemp())
sys.path.insert(0, scripts)
import accounts_override  # noqa: E402
import allocator  # noqa: E402
from capability_catalog import compose  # noqa: E402

base = accounts_override.normalize(json.loads(open(os.path.join(references, "accounts.json"), encoding="utf-8-sig").read()))
capabilities = compose(base)
policy = base["scoring"]
dispatch = base.get("dispatch_efforts") or {}
NOW = datetime(2026, 11, 7, tzinfo=timezone.utc)

SPELLINGS = [k for k, v in base["models"].items() if isinstance(v, dict) and k != "basis"] + [
    "claude-opus-5-5-20261001", "claude-opus-4-6@20250514", "gpt-6-astra-preview", "gpt-6.1-sol-latest",
    "openrouter/anthropic/claude-opus-4-6:free", "OpenAI/GPT-6-Astra-Latest", "CLAUDE-OPUS-5-5",
    "claude-opus-9", "claude-sonnet-6", "gpt-6.2-sol-preview", "gpt-6.2-luna-20261101", "gemini-4-pro-exp",
    "gemini-4-flash-exp", "grok-4-fast", "deepseek-r2-preview", "minimax-m4", "minimax-m4-flash", "glm-6-flash",
    "claude-opus-5-5[1m]", "gpt-5.4", "o4-mini-2025-04-16", "totally-unknown-model", "gpt-5.3-codex-spark",
    "gpt-6-astra-medium", "claude-opus-5-5-medium", "gemini-2.5-pro",
]
EFFORT_SUBSETS = [["high"], ["low", "high"], ["medium", "high", "xhigh"], ["low", "medium", "high", "xhigh", "max"]]
POOLS = [
    ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra", "gpt-6.1-sol"],
    ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
    ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"],
    ["gemini-4-argon-high", "gemini-3.8-flash-high", "grok-4.7", "deepseek-v4-pro"],
    ["claude-opus-5-5-20261001", "gpt-6-astra-preview", "gemini-4-pro-exp", "claude-opus-9"],
    ["claude-sonnet-5-5", "gpt-6.1-sol", "gemini-3.8-flash-high", "kimi-k3.1-pro", "glm-5.3", "qwen3.8-max"],
    ["grok-bot", "gpt-6-pro", "claude-opus-5-5", "gpt-6-luna"],
    ["deepseek-v4.1-flash-free", "glm-5.3-flash-free", "minimax-m3.1-flash", "mimo-v2.6-flash-free"],
    ["gpt-6-luna", "gemini-3.8-flash-high"],
]
EVERY_ROW = [k for k, v in base["models"].items() if isinstance(v, dict) and k != "basis"]
KINDS = [k for k in capabilities["routes"]]
BASE = {"context_scale": 1, "needs_visual": False, "needs_gui": False, "local_only": False, "expected_hours": 1.0,
        "hours_confidence": "medium", "urgency": "unknown", "multi_task": False, "task_count": "1"}
BOUNDARIES = {
    "routine": {"reasoning_depth": 1, "code_complexity": 0, "divergence": 1, "hallucination_risk": 1, "error_cost": 1, "interaction_style": "text_only"},
    "runbook_critical": {"reasoning_depth": 1, "code_complexity": 0, "divergence": 1, "hallucination_risk": 2, "error_cost": 3, "interaction_style": "engineering"},
    "standard": {"reasoning_depth": 2, "code_complexity": 2, "context_scale": 2, "divergence": 1, "hallucination_risk": 2, "error_cost": 2, "interaction_style": "engineering"},
    "strict_review": {"reasoning_depth": 2, "code_complexity": 0, "divergence": 1, "hallucination_risk": 3, "error_cost": 2, "interaction_style": "exploration"},
    "risky": {"reasoning_depth": 2, "code_complexity": 2, "divergence": 2, "hallucination_risk": 3, "error_cost": 2, "interaction_style": "engineering"},
    "coupled": {"reasoning_depth": 3, "code_complexity": 3, "context_scale": 3, "divergence": 2, "hallucination_risk": 2, "error_cost": 2, "interaction_style": "engineering"},
    "critical": {"reasoning_depth": 3, "code_complexity": 2, "context_scale": 2, "divergence": 1, "hallucination_risk": 2, "error_cost": 3, "interaction_style": "engineering"},
    "frontier": {"reasoning_depth": 4, "code_complexity": 3, "context_scale": 3, "divergence": 3, "hallucination_risk": 3, "error_cost": 3, "interaction_style": "advisory"},
    "visual": {"reasoning_depth": 2, "code_complexity": 1, "divergence": 1, "hallucination_risk": 2, "error_cost": 2, "interaction_style": "engineering", "needs_visual": True},
    "gui": {"reasoning_depth": 2, "code_complexity": 0, "divergence": 1, "hallucination_risk": 2, "error_cost": 2, "interaction_style": "engineering", "needs_visual": True, "needs_gui": True},
    "local": {"reasoning_depth": 2, "code_complexity": 2, "divergence": 1, "hallucination_risk": 2, "error_cost": 2, "interaction_style": "engineering", "local_only": True},
}
PROFILES = [{**BASE, **shape, "work_kind": kind} for kind in KINDS for shape in BOUNDARIES.values()]
SINGLE_MODEL_PROFILES = [i for i, p in enumerate(PROFILES) if list(BOUNDARIES.values()).index(
    next(s for s in BOUNDARIES.values() if all(p.get(k) == v for k, v in s.items()))) in (0, 2, 7)]
# none / the model / the model and an effort / `model:effort`.
PIN_MODES = ["none", "model", "model+effort", "model:effort"]


def own_provider(key):
    # A real launch provider for the model; a gateway, with no dispatch row, otherwise.
    return next((p for p, table in dispatch.items() if key in table), "openrouter")


def make_bundles(models, efforts):
    out = {}
    for name in models:
        key = allocator.canonical(name, base)
        provider = own_provider(key)
        for effort in efforts:
            bundle_id = f"{name}:{effort}"
            out[bundle_id] = {"provider": provider, "model": name, "effort": effort}
    return out


def account_spec(bundles):
    accounts = {}
    for bundle_id, bundle in bundles.items():
        spec = accounts.setdefault(bundle["provider"], {"billing": "subscription", "verified": True, "bundles": {}})
        spec["bundles"][bundle_id] = bundle
    return {**base, "accounts": accounts}


def route(bundles, profile, realtime, pin, pin_model, pin_effort):
    task_raw = {"profile": profile, "realtime_loop": realtime, "needs": {"realtime_loop": realtime}}
    if pin == "model":
        task_raw["constraints"] = {"model": pin_model}
    elif pin == "model+effort":
        task_raw["constraints"] = {"model": pin_model, "effort": pin_effort}
    elif pin == "model:effort":
        task_raw["constraints"] = {"model": f"{pin_model}:{pin_effort}"}
    accounts = account_spec(bundles)
    task = allocator.normalize_task(task_raw, policy, capabilities, accounts)
    unavailable = ["dot_text"]
    host_policy = {"allowed_accounts": list(accounts["accounts"])}
    candidates, eligible, _ = allocator.rank(task, {}, policy, accounts, capabilities, NOW, unavailable=unavailable, host_policy_config=host_policy)
    # As `plan()`: a model named without an effort, too slow at every effort it can run, takes its fastest one.
    if (not eligible and task.get("realtime_loop") and task["constraint_model"] and not task.get("constraint_effort")
            and not task.get("constraint_bundle") and any(c.get("too_slow") and len(c["excluded"]) == 1 for c in candidates)):
        task["slow_pin_fallback"] = True
        _, eligible, _ = allocator.rank(task, {}, policy, accounts, capabilities, NOW, unavailable=unavailable, host_policy_config=host_policy)
        fastest = max((c["components"].get("responsiveness") or 0.0 for c in eligible), default=0.0)
        eligible = [c for c in eligible if (c["components"].get("responsiveness") or 0.0) >= fastest]
    top = eligible[0] if eligible else None
    if not top:
        return None
    return [top["bundle"]["model"], top["bundle"].get("effort"), top["score"]]


rows = []
seen = 0


def emit(pool_ref, subset, profile_index, realtime, pin, models):
    global seen
    seen += 1
    if (seen - 1) % args.sample:
        return
    bundles = make_bundles(models, EFFORT_SUBSETS[subset])
    pin_model = models[0]
    pin_effort = EFFORT_SUBSETS[subset][0]
    try:
        result = route(bundles, PROFILES[profile_index], bool(realtime), PIN_MODES[pin], pin_model, pin_effort)
    except Exception as err:  # noqa: BLE001 - a refusal is a result to compare, not a crash of the generator
        result = ["!" + type(err).__name__, str(err)[:80], None]
    rows.append([pool_ref, subset, profile_index, realtime, pin, result])


for spelling_index, spelling in enumerate(SPELLINGS):
    for subset in range(len(EFFORT_SUBSETS)):
        for realtime in (0, 1):
            for pin in range(len(PIN_MODES)):
                for profile_index in SINGLE_MODEL_PROFILES:
                    emit(spelling_index, subset, profile_index, realtime, pin, [spelling])
for pool_index, pool in enumerate(POOLS):
    for subset in range(len(EFFORT_SUBSETS)):
        for realtime in (0, 1):
            for pin in range(len(PIN_MODES)):
                for profile_index in range(len(PROFILES)):
                    emit(len(SPELLINGS) + pool_index, subset, profile_index, realtime, pin, pool)
# The whole catalog at every effort, unpinned: what the default pool of a gateway would pick from.
for realtime in (0, 1):
    for profile_index in range(len(PROFILES)):
        emit(len(SPELLINGS) + len(POOLS), len(EFFORT_SUBSETS) - 1, profile_index, realtime, 0, EVERY_ROW)

fixture = {
    "source": {"repo": "AgentCompass", "commit": args.commit, "file": "skills/agent-compass/scripts/allocator.py"},
    "grid_size": seen,
    "sample": args.sample,
    "spellings": SPELLINGS,
    "pools": [*POOLS, EVERY_ROW],
    "providers": {name: own_provider(allocator.canonical(name, base)) for pool in [SPELLINGS, *POOLS] for name in pool},
    "canonical": {name: allocator.canonical(name, base) for pool in [SPELLINGS, *POOLS] for name in pool},
    "effort_subsets": EFFORT_SUBSETS,
    "pin_modes": PIN_MODES,
    "profiles": PROFILES,
    "rows": rows,
}
with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(fixture, fh, ensure_ascii=False, separators=(",", ":"))
print(f"{len(rows)} of {seen} rows -> {args.out}")
