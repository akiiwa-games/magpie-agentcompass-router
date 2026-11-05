#!/bin/sh
set -eu

if [ -d "/mnt/c/Users/tanwei/.gemini/antigravity-cli/brain/8d5cec5e-b7a5-4cc4-bb52-1d29bd1b8676/scratch" ]; then
  SCRATCH="/mnt/c/Users/tanwei/.gemini/antigravity-cli/brain/8d5cec5e-b7a5-4cc4-bb52-1d29bd1b8676/scratch"
else
  SCRATCH="/mnt/host/c/Users/tanwei/.gemini/antigravity-cli/brain/8d5cec5e-b7a5-4cc4-bb52-1d29bd1b8676/scratch"
fi

if [ -d "/mnt/e/PROJECTS/magpie-agentcompass-router" ]; then
  REPO="/mnt/e/PROJECTS/magpie-agentcompass-router"
else
  REPO="/mnt/host/e/PROJECTS/magpie-agentcompass-router"
fi

SANDBOX="/run/magpie-sandbox"

cleanup() {
  pkill -f "$SANDBOX/magpie" 2>/dev/null || true
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX/home" "$SANDBOX/config" "$SANDBOX/cache" "$SANDBOX/data" "$SANDBOX/state" "$SANDBOX/tmp" "$SANDBOX/agentcompass"

# MAGPIE_LINUX_BIN: the Magpie build under test (a release's static magpie-cli-linux-amd64, e.g. 0.1.2891)
cp "${MAGPIE_LINUX_BIN:-$SCRATCH/magpie-linux-amd64}" "$SANDBOX/magpie"
chmod +x "$SANDBOX/magpie"
cp -r "$REPO"/* "$SANDBOX/agentcompass/"

export HOME="$SANDBOX/home"
export TMPDIR="$SANDBOX/tmp"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_CACHE_HOME="$SANDBOX/cache"
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_STATE_HOME="$SANDBOX/state"
export PLUGIN_DIR="$SANDBOX/agentcompass"
export NO_COLOR=1

if [ -f "$SCRATCH/bun-linux-musl" ]; then
  cp "$SCRATCH/bun-linux-musl" "$SANDBOX/bun"
  chmod +x "$SANDBOX/bun"
  export MAGPIE_BUN="$SANDBOX/bun"
fi

echo "=== [1/4] Linux Sandbox System Info ==="
uname -a
cat /etc/os-release | head -n 4
"$SANDBOX/magpie" --version

echo "=== [2/4] Installing & Signing In Plugin in Real Linux Magpie ==="
"$SANDBOX/magpie" plugin add "$PLUGIN_DIR"
# The decision provider (Mode B) exists only with enableDecisionProvider on, so set it before signing in
"$SANDBOX/magpie" plugin options "$PLUGIN_DIR" '{"enableDecisionProvider": true}'
"$SANDBOX/magpie" plugin login agentcompass
"$SANDBOX/magpie" plugin list

BUN_BIN=$(find "$SANDBOX" -type f \( -name 'magpie-bun' -o -name 'bun' \) | head -n 1)
if [ -n "$BUN_BIN" ] && [ ! -f "$SCRATCH/bun-linux-musl" ]; then
  cp "$BUN_BIN" "$SCRATCH/bun-linux-musl"
fi
export MAGPIE_BUN="$BUN_BIN"
echo "Linux Bun runtime: $BUN_BIN ($("$BUN_BIN" --version))"

echo "=== [3/4] Running Unit Tests Inside Linux Sandbox ==="
"$BUN_BIN" test "$PLUGIN_DIR/test/router.test.mjs"

echo "=== [4/4] Running Live Magpie Web + Gateway Full-Chain E2E Tests Inside Linux Sandbox ==="
"$BUN_BIN" "$PLUGIN_DIR/test/linux-sandbox-e2e.mjs"
cp "$SANDBOX/e2e-report.json" "$REPO/docs/linux-sandbox-e2e-report.json"
