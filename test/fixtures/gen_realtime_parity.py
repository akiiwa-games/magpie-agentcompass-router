"""Regenerate test/fixtures/agentcompass-realtime-parity.json from a real AgentCompass checkout.

    python -X utf8 test/fixtures/gen_realtime_parity.py E:/PROJECTS/route_manager

The test suite compares the JS port against this output, so it needs neither Python nor the checkout to run.
Rerun after syncing catalog data from AgentCompass. No local telemetry: state_dir points at an empty directory.
"""
import json
import os
import subprocess
import sys
import tempfile

root = sys.argv[1] if len(sys.argv) > 1 else "E:/PROJECTS/route_manager"
sys.path.insert(0, os.path.join(root, "skills/agent-compass/scripts"))
import allocator  # noqa: E402

accounts = json.loads(
    open(os.path.join(root, "skills/agent-compass/references/accounts.json"), encoding="utf-8-sig").read()
)
policy = accounts["scoring"]
empty = tempfile.mkdtemp()

EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "default"]
# A provider with no dispatch table row (a gateway); real launch providers are added per model below.
GATEWAY = "openrouter"

# Spellings seen in gateways and in the review probes: dates, -latest/-preview/-chat, case, prefixes, [1m], families, aliases.
VARIANTS = [
    "claude-opus-5-5-20261001", "claude-opus-5-5@20261001", "claude-opus-4-6-20250514", "claude-opus-4-6@20250514",
    "claude-sonnet-5-5-20261001", "claude-sonnet-4-6-20250514", "claude-haiku-5-5-20261001",
    "claude-haiku-4-5@20251001", "claude-haiku-4-5-20251001", "gpt-6-astra-20261001", "gpt-6.1-sol-20261001",
    "gpt-6-pro-20261001", "gemini-4-argon-high-20261001", "deepseek-v4-pro-20261001", "qwen3-max-2026-01-23",
    "qwen3-max-2026-01-23-20260201", "claude-opus-5-5-latest", "claude-opus-4-6-latest", "claude-sonnet-4-6-preview",
    "gpt-6-astra-preview", "gpt-6.1-sol-latest", "gemini-4-argon-high-preview", "grok-4.7-latest",
    "kimi-k3.1-pro-preview", "kimi-k2.6-preview", "glm-5.3-latest", "glm-5.2-latest", "CLAUDE-OPUS-5-5",
    "Anthropic/Claude-Opus-4-6-20250514", "OpenAI/GPT-6-Astra-Latest", "OpenRouter/Google/Gemini-4-Argon-High-Preview",
    "XAI/Grok-4.7:HIGH", "Claude-Haiku-4-5@20251001", "openrouter/anthropic/claude-opus-4-6:max",
    "openrouter/openai/gpt-6.1-sol-20261001:xhigh", "vertex_ai/claude-sonnet-4-6@20250514:high",
    "claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-haiku-4-20250514", "gpt-6-experimental",
    "gpt-6.2-sol-preview", "gpt-6.2-terra-latest", "gpt-6.2-luna-20261101", "gpt-6.2-pro-20261101", "gemini-4-pro-exp",
    "gemini-4-flash-exp", "grok-4-fast", "grok-code-fast-1", "deepseek-r2-preview", "deepseek-v4-flash-exp",
    "qwen3.9-coder-preview", "qwen3.9-max-latest", "moonshot-v1-128k", "kimi-k4-preview", "glm-6-flash", "glm-6-plus",
    "minimax-m4-flash", "minimax-m4", "abab7-chat", "doubao-pro-256k", "mimo-v3-flash", "mimo-v3-pro",
    "nemotron-4-lightning", "nemotron-4-super", "nemotron-4-ultra", "muse-wonder-2.0", "codestral-2501",
    "devstral-small", "mistral-large-4-20260101", "deepseek-v4-pro-20260101", "deepseek-r1", "deepseek-v3",
    "deepseek-reasoner", "deepseek-chat", "deepseek-flash", "deepseek-v4-flash", "deepseek-pro-20250501", "deepseek",
    "zai-org-glm-5-2", "venice-api/zai-org-glm-5-2", "qwen-flash", "grok-4", "grok-3", "grok-3-mini", "grok-bot",
    "xai/grok-4.6", "grok-4.6-latest", "anthropic/claude-opus-4-7-20260101", "claude-opus-5", "claude-sonnet-5",
    "claude-fable-5", "argon", "gemini-4-argon", "gemini-4-pro", "gemini-4-ultra", "gemini-2.5-pro", "gemini-2.5-flash",
    "gemini-3.8-flash", "google/gemini-3.8-flash", "claude-opus-5-5[1m]", "claude-sonnet-4-6[1m]", "claude-opus-4-6[1m]",
    "claude-haiku-4-5[1m]", "CLAUDE-SONNET-4-6", "gpt-5", "gpt-5-chat", "openai/gpt-5-chat", "gpt-5.4", "gpt-5.5", "gpt-5.3-codex-spark",
    "o3", "o3-mini", "o3-mini-2025-01-31", "o4-mini-2025-04-16", "gpt-5-2025-08-07", "claude-3-opus", "claude-3-5-haiku",
    "claude-3-7-sonnet-20250219", "llama-4-maverick", "meta-llama/llama-3.3-70b-instruct:free", "totally-unknown-model",
    "gpt-6.10-terra", "ChatGPT Pro via chatgpt-pro-consult",
]

models = [k for k, v in accounts["models"].items() if isinstance(v, dict)]
names = models + [v for v in VARIANTS if v not in models]
dispatch = accounts.get("dispatch_efforts") or {}


def own_provider(canon):
    return next((p for p, table in dispatch.items() if canon in table), None)


def step(model, effort, provider, gate):
    canon = allocator.canonical(model, accounts)
    info = allocator.model_spec(accounts, model)
    curves = (accounts.get("effort_curves") or {}).get(canon) or {}
    bundle = {"model": model, "effort": effort, "provider": provider, "account": provider}
    ctx = {"accounts": accounts, "policy": policy, "bundles": {}, "state_dir": empty}
    eff, val, src, stepped = allocator.resolve_realtime_effort(
        bundle, {"realtime_loop": True}, ctx, canon, info, policy, curves, gate
    )
    return [model, effort, provider, gate, eff, val, src, stepped]


rows = []
for name in names:
    canon = allocator.canonical(name, accounts)
    providers = [GATEWAY] + ([own_provider(canon)] if own_provider(canon) else [])
    gates = [0.0, 3.0, 4.2] if name in models else [3.0]
    for effort in EFFORTS:
        for provider in providers:
            for gate in gates:
                rows.append(step(name, effort, provider, gate))

responsiveness = {}
for name in names:
    canon = allocator.canonical(name, accounts)
    info = allocator.model_spec(accounts, name)
    curves = (accounts.get("effort_curves") or {}).get(canon) or {}
    responsiveness[name] = {
        eff: list(allocator.bundle_responsiveness({"model": name, "effort": eff}, info, policy, curves, state_dir=empty))
        for eff in EFFORTS
    }

commit = subprocess.run(["git", "-C", root, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
out = {
    "source": {"repo": "AgentCompass", "commit": commit, "file": "skills/agent-compass/references/accounts.json"},
    "models": models,
    "variants": VARIANTS,
    "canonical": {name: allocator.canonical(name, accounts) for name in names},
    "effort_curves": {k: v for k, v in accounts["effort_curves"].items() if isinstance(v, dict)},
    "dispatch_efforts": dispatch,
    "responsiveness": responsiveness,
    "stepdown_columns": ["model", "effort", "provider", "gate", "effective", "value", "source", "stepped_from"],
    "stepdown": rows,
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agentcompass-realtime-parity.json")
with open(path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    f.write("\n")
print(f"{path}: {len(names)} names ({len(VARIANTS)} variants), {len(rows)} step-down rows, commit {commit}")
