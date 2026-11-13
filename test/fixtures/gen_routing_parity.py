"""Regenerate test/fixtures/agentcompass-routing-parity.json from AgentCompass's allocator.py at a pinned commit.

    python -I -X utf8 test/fixtures/gen_routing_parity.py [--repo <checkout>] [--commit <sha>] [--sample N] [--out <path>]

The checkout comes from --repo or the MAGPIE_AGENTCOMPASS_REPO environment variable; the commit from --commit,
MAGPIE_AGENTCOMPASS_COMMIT, or test/fixtures/agentcompass-pin.json. Nothing about any machine is written to the pin.

The grid crosses model spellings, effort subsets, how the user pins, and task profiles (four demand categories, boundaries of
difficulty, access, image input, fast, and hours). Both sides get the same explicit bundles and the same profile, no usage and
no local state; `allocator.plan` is the reference. test/routing-parity.test.mjs routes each row with the JS port and compares
the winner and its score. Without --sample the whole grid is written, for a local report; the committed fixture is a sample.
Reads AgentCompass only through `git archive <commit>`, never a working tree.
"""
import argparse
import copy
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
parser.add_argument("--repo", default=os.environ.get("MAGPIE_AGENTCOMPASS_REPO"))
parser.add_argument("--commit", default=os.environ.get("MAGPIE_AGENTCOMPASS_COMMIT", PIN["commit"]))
parser.add_argument("--sample", type=int, default=1)
parser.add_argument("--out", default=os.path.join(HERE, "agentcompass-routing-parity.json"))
args = parser.parse_args()
if not args.repo:
    sys.exit("pass --repo <AgentCompass checkout> or set MAGPIE_AGENTCOMPASS_REPO")

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
os.environ["AGENTCOMPASS_PUBLIC_DATA"] = "off"
sys.path.insert(0, scripts)
import accounts_override  # noqa: E402
import allocator  # noqa: E402
import account_fleet  # noqa: E402
import axis_scores  # noqa: E402
import quota_economy  # noqa: E402
import task_intake  # noqa: E402
from capability_catalog import compose  # noqa: E402

base = accounts_override.normalize(json.loads(open(os.path.join(references, "accounts.json"), encoding="utf-8-sig").read()))
capabilities = compose(base)
dispatch = base.get("dispatch_efforts") or {}
NOW = datetime(2026, 11, 7, tzinfo=timezone.utc)

MODEL_KEYS = [k for k, v in base["models"].items() if isinstance(v, dict) and k != "basis"]
SPELLINGS = MODEL_KEYS + [
    "claude-opus-5-5-20261001", "claude-opus-4-6@20250514", "gpt-6-astra-preview", "gpt-6.1-sol-latest",
    "openrouter/anthropic/claude-opus-4-6:free", "OpenAI/GPT-6-Astra-Latest", "CLAUDE-OPUS-5-5",
    "claude-opus-9", "claude-sonnet-6", "gpt-6.2-sol-preview", "gemini-4-pro-exp", "grok-4-fast",
    "deepseek-r2-preview", "minimax-m4", "glm-6-flash", "claude-opus-5-5[1m]", "gpt-5.4",
    "o4-mini-2025-04-16", "totally-unknown-model", "gpt-6-astra-medium", "claude-opus-5-5-medium", "gemini-2.5-pro",
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
    # A family row beside the model it folds to, each pinned in turn: it is another model.
    ["claude-opus-5-5", "claude-opus-9"],
    ["claude-opus-9", "claude-opus-5-5"],
]
EVERY_ROW = list(MODEL_KEYS)
KINDS = list(task_intake.PROFILE_KINDS)
BASE = {"work_kind": "general_implementation", "reasoning_depth": 2, "code_complexity": 2, "needs_visual": False,
        "needs_gui": False, "local_only": False, "wants_fast": False, "read_only_review": False, "access": "write",
        "expected_hours": 1.0, "hours_confidence": "medium", "urgency": "normal", "interaction_style": "engineering",
        "multi_task": False, "task_count": "1",
        "axis_demand": {"divergence": 1, "coding": 2, "aesthetics": 0, "tool_operation": 0}}


def shape(demand=None, **changes):
    return {**BASE, **changes, "axis_demand": {**BASE["axis_demand"], **(demand or {})}}


SHAPES = {
    "routine": shape({"divergence": 0, "coding": 0}, reasoning_depth=1, code_complexity=0, access="read-only", interaction_style="text_only"),
    "light": shape({"divergence": 0, "coding": 1}, reasoning_depth=1, code_complexity=1),
    "standard": shape(),
    "review": shape({"coding": 2}, code_complexity=0, access="read-only", read_only_review=True, interaction_style="exploration"),
    "design": shape({"divergence": 3, "coding": 1}, reasoning_depth=3, interaction_style="advisory"),
    "coupled": shape({"divergence": 2, "coding": 3}, reasoning_depth=3, code_complexity=3, expected_hours=4.0),
    "frontier": shape({"divergence": 3, "coding": 3, "aesthetics": 1, "tool_operation": 1}, reasoning_depth=4, code_complexity=3, expected_hours=8.0),
    "aesthetic": shape({"divergence": 1, "coding": 2, "aesthetics": 3}, reasoning_depth=2, code_complexity=2),
    "visual": shape({"coding": 1, "tool_operation": 3}, code_complexity=1, needs_visual=True),
    "gui": shape({"coding": 0, "tool_operation": 2}, code_complexity=0, access="read-only", needs_visual=True, needs_gui=True),
    "tools": shape({"coding": 1, "tool_operation": 2}, code_complexity=1),
    "local": shape(local_only=True),
    "fast": shape(wants_fast=True, urgency="high", expected_hours=0.25),
    "relaxed": shape(urgency="low", expected_hours=12.0, hours_confidence="low"),
}
SHAPE_NAMES = list(SHAPES)
PROFILES = []
for kind in KINDS:
    for name in SHAPE_NAMES:
        PROFILES.append({**SHAPES[name], "work_kind": kind})
# One representative of each shape for the single-model grid, the standard kind only.
SINGLE_MODEL_PROFILES = [i for i, p in enumerate(PROFILES) if p["work_kind"] == "general_implementation"]
PIN_MODES = ["none", "model", "model+effort", "model:effort"]  # none / the model / the model and an effort / `model:effort`.


def own_provider(name):
    # A real launch provider for the model; a gateway, with no dispatch row, otherwise.
    key = account_fleet.row_key(name, base)
    return next((p for p, table in dispatch.items() if key in table), "openrouter")


def make_bundles(models, efforts):
    out = {}
    for name in models:
        provider = own_provider(name)
        for effort in efforts:
            out[f"{name}:{effort}"] = {"provider": provider, "model": name, "effort": effort}
    return out


def account_spec(bundles):
    accounts = {}
    for bundle_id, bundle in bundles.items():
        spec = accounts.setdefault(bundle["provider"], {"family": None, "billing": "subscription", "verified": True,
                                                         "unmetered": True, "windows": {}, "capacity_usd": {}, "bundles": {}})
        spec["bundles"][bundle_id] = bundle
    return {**base, "accounts": accounts}


def valid(profile):
    try:
        task_intake.normalize_task({"objective": "parity", "profile": profile}, base["scoring"], capabilities, base)
    except Exception as err:  # noqa: BLE001
        if os.environ.get('PARITY_DEBUG'):
            print('invalid profile:', err, file=sys.stderr)
        return False
    return True


def route(bundles, profile, pin, pin_model, pin_effort):
    task_raw = {"objective": "parity", "profile": profile, "expected_hours": profile["expected_hours"]}
    if pin == "model":
        task_raw["constraints"] = {"model": pin_model}
    elif pin == "model+effort":
        task_raw["constraints"] = {"model": pin_model, "effort": pin_effort}
    elif pin == "model:effort":
        task_raw["constraints"] = {"model": f"{pin_model}:{pin_effort}"}
    accounts = account_spec(bundles)
    result = allocator.plan(task_raw, {"accounts": {}}, NOW, unavailable=(), accounts=accounts, overrides=[],
                            host_policy_config={"allowed_accounts": list(accounts["accounts"])}, read_local_state=False)
    if result.get("choice") in (None, "none"):
        return None
    top = next(c for c in result["ranking"] if c["id"] == result["choice"])
    return [top["bundle"]["model"], top["bundle"].get("effort"), top["score"]]


rows = []
seen = 0
VALID = {}


def emit(pool_ref, subset, profile_index, pin, models):
    global seen
    if profile_index not in VALID:
        VALID[profile_index] = valid(PROFILES[profile_index])
    if not VALID[profile_index]:
        return
    seen += 1
    if (seen - 1) % args.sample:
        return
    bundles = make_bundles(models, EFFORT_SUBSETS[subset])
    pin_model = models[0]
    pin_effort = EFFORT_SUBSETS[subset][0]
    try:
        result = route(bundles, PROFILES[profile_index], PIN_MODES[pin], pin_model, pin_effort)
    except Exception as err:  # noqa: BLE001 - a refusal is a result to compare, not a crash of the generator
        result = ["!" + type(err).__name__, None, None]
    rows.append([pool_ref, subset, profile_index, pin, result])


for spelling_index, spelling in enumerate(SPELLINGS):
    for subset in range(len(EFFORT_SUBSETS)):
        for pin in range(len(PIN_MODES)):
            for profile_index in SINGLE_MODEL_PROFILES:
                emit(spelling_index, subset, profile_index, pin, [spelling])
for pool_index, pool in enumerate(POOLS):
    for subset in range(len(EFFORT_SUBSETS)):
        for pin in range(len(PIN_MODES)):
            for profile_index in range(len(PROFILES)):
                emit(len(SPELLINGS) + pool_index, subset, profile_index, pin, pool)
# The whole catalog at every effort, unpinned: what the default pool of a gateway would pick from.
for profile_index in range(len(PROFILES)):
    emit(len(SPELLINGS) + len(POOLS), len(EFFORT_SUBSETS) - 1, profile_index, 0, EVERY_ROW)

# Bare names on a provider: a pool entry with no effort, as a gateway user writes it. The launch table decides what a provider offers
# (`account_fleet.dispatch_allowed_efforts`): the listed efforts when it lists the model, nothing when it has a table that does not
# list it (one row with no effort of its own), and, with no table at all (a gateway), the efforts the data times. Each case puts
# every catalog model on one provider; both sides get the same rows (Python spells out the efforts the table or the data gives).
BARE_PROVIDERS = ["claude", "codex", "grok", "pi", "opencode", "omp", "antigravity-resilient", "antigravity", "claude-2", "openrouter"]
scored = axis_scores.five_axis_overlay(copy.deepcopy(base), read_local_state=False)


def timed_efforts(name):
    key = account_fleet.row_key(name, base)
    by_effort = ((((scored["models"].get(key) or {}).get("five_axis") or {}).get("duration") or {}).get("by_effort") or {})
    return [e for e in quota_economy.EFFORT_ORDER if e in by_effort]


def bare_bundles(provider, models):
    out = {}
    for name in models:
        allowed = account_fleet.dispatch_allowed_efforts({"provider": provider, "model": name}, base, name)
        fixed = bool(((scored["models"].get(account_fleet.row_key(name, base)) or {}).get("fixed_effort")))
        if fixed or (allowed is not None and len(allowed) == 0):
            out[name] = {"provider": provider, "model": name}
            continue
        efforts = [e for e in quota_economy.EFFORT_ORDER if e in (allowed if allowed is not None else timed_efforts(name))]
        if not efforts:
            out[name] = {"provider": provider, "model": name}
        for effort in efforts:
            out[f"{name}:{effort}"] = {"provider": provider, "model": name, "effort": effort}
    return out


bare_rows = []
for case, provider in enumerate(BARE_PROVIDERS):
    bundles = bare_bundles(provider, EVERY_ROW)
    for profile_index in SINGLE_MODEL_PROFILES:
        if not VALID.get(profile_index, valid(PROFILES[profile_index])):
            continue
        for pin_model in (None, EVERY_ROW[(profile_index * 7 + case) % len(EVERY_ROW)]):
            try:
                result = route(bundles, PROFILES[profile_index], "none" if pin_model is None else "model", pin_model, None)
            except Exception as err:  # noqa: BLE001
                result = ["!" + type(err).__name__, None, None]
            bare_rows.append([case, profile_index, pin_model, result])

fixture = {
    "source": {"repo": "AgentCompass", "commit": args.commit, "file": "skills/agent-compass/scripts/allocator.py"},
    "now": NOW.isoformat(),
    "grid_size": seen,
    "sample": args.sample,
    "spellings": SPELLINGS,
    "pools": [*POOLS, EVERY_ROW],
    "providers": {name: own_provider(name) for pool in [SPELLINGS, *POOLS] for name in pool},
    "effort_subsets": EFFORT_SUBSETS,
    "pin_modes": PIN_MODES,
    "profiles": PROFILES,
    "rows": rows,
    "bare_providers": BARE_PROVIDERS,
    "bare_models": EVERY_ROW,
    "bare_rows": bare_rows,
}
with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(fixture, fh, ensure_ascii=False, separators=(",", ":"))
print(f"{len(rows)} of {seen} rows, {len(bare_rows)} bare-name rows -> {args.out}")
