#!/bin/sh
set -eu

SANDBOX="/run/magpie-sandbox"

# WSL appends Windows' directories to PATH. Magpie looks for agents there (claude, grok), and one found there runs on the
# host, with the host's own sign-ins.
PATH=$(echo "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd: -)
export PATH
unset WSLENV

export HOME="$SANDBOX/home"
export TMPDIR="$SANDBOX/tmp"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_CACHE_HOME="$SANDBOX/cache"
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_STATE_HOME="$SANDBOX/state"
export PLUGIN_DIR="$SANDBOX/agentcompass"
export NO_COLOR=1

PE_PROBE="$SANDBOX/interop-probe.exe"
HOST_MOUNTS='$3 == "9p" || $3 == "drvfs" || $3 == "virtiofs" { print $2 }'

# Takes the host out of sight of everything Scenario 13 runs as root: the host's drives and the mounts of its files, the way
# back through interop, and (being in its own PID namespace) /proc/<pid>/root of what runs outside.
hide_the_host() {
  cd /
  # /etc/resolv.conf points into a directory hidden below
  resolv_at=$(readlink -f /etc/resolv.conf)
  resolv=$(cat /etc/resolv.conf)
  for d in /mnt/* /mnt/host/* /run/WSL $(awk "$HOST_MOUNTS" /proc/mounts); do
    [ -d "$d" ] && [ "$d" != /mnt/host ] || continue
    umount -l "$d" 2>/dev/null || true
    mount -t tmpfs none "$d"
  done
  mkdir -p "$(dirname "$resolv_at")"
  printf '%s\n' "$resolv" > "$resolv_at"
  unset WSL_INTEROP WSL_DISTRO_NAME DISPLAY WAYLAND_DISPLAY PULSE_SERVER XDG_RUNTIME_DIR

  abort() {
    echo "[ABORT] The host is still in reach, so no real sign-in may run here: $1" >&2
    exit 70
  }
  [ "$$" = 1 ] || abort "this runs without a PID namespace of its own"
  for f in $HOST_SIGN_INS; do
    [ ! -e "$f" ] || abort "a sign-in file is visible"
    [ ! -e "/proc/1/root$f" ] || abort "a sign-in file is visible through /proc"
  done
  for d in /mnt/* /mnt/host/*; do
    [ -d "$d" ] && [ "$d" != /mnt/host ] && [ "$d" != "$(dirname "$resolv_at")" ] || continue
    [ -z "$(ls -A "$d")" ] || abort "$d is readable"
  done
  [ -z "$(awk "$HOST_MOUNTS" /proc/mounts)" ] || abort "a mount of the host's files is left"
  for cmd in /mnt/host/c/Windows/System32/cmd.exe /mnt/c/Windows/System32/cmd.exe; do
    ! "$cmd" /c exit 0 >/dev/null 2>&1 || abort "$cmd runs"
  done
  pe=no-probe
  if [ -f "$PE_PROBE" ]; then
    ! "$PE_PROBE" >/dev/null 2>&1 || abort "a Windows program runs on the host from the sandbox's own files"
    pe=refused
  fi
  printf '{"signInFilesVisible":false,"hostDrivesReadable":false,"hostMountsLeft":0,"cmdExe":"refused","windowsProgramOnTmpfs":"%s","pidNamespace":true}\n' "$pe" > "$SANDBOX/isolation.json"
  echo "[Host isolation] inside the namespace: sign-in files gone, host drives empty, no host mounts, cmd.exe refused, Windows program on tmpfs $pe"
  unset HOST_SIGN_INS
  export MAGPIE_HOST_HIDDEN=1
}

# Everything that runs Magpie
run_in_sandbox() {
  cd "$PLUGIN_DIR"
  echo "=== [1/4] Linux Sandbox System Info ==="
  uname -a
  head -n 4 /etc/os-release
  "$SANDBOX/magpie" --version
  MAGPIE_BINARY_SHA256="$(sha256sum "$SANDBOX/magpie" | cut -d' ' -f1)"
  export MAGPIE_BINARY_SHA256
  echo "sha256 $MAGPIE_BINARY_SHA256"

  echo "=== [2/4] Installing & Signing In Plugin in Real Linux Magpie ==="
  "$SANDBOX/magpie" plugin add "$PLUGIN_DIR"
  # The decision provider (Mode B) exists only with enableDecisionProvider on, so set it before signing in
  "$SANDBOX/magpie" plugin options "$PLUGIN_DIR" '{"enableDecisionProvider": true}'
  "$SANDBOX/magpie" plugin login agentcompass
  "$SANDBOX/magpie" plugin list

  BUN_BIN=$(find "$SANDBOX" -type f \( -name 'magpie-bun' -o -name 'bun' \) | head -n 1)
  if [ -n "$BUN_BIN" ] && [ -n "${SCRATCH:-}" ] && [ ! -f "$SCRATCH/bun-linux-musl" ]; then
    cp "$BUN_BIN" "$SCRATCH/bun-linux-musl"
  fi
  export MAGPIE_BUN="$BUN_BIN"
  echo "Linux Bun runtime: $BUN_BIN ($("$BUN_BIN" --version))"

  echo "=== [3/4] Running Unit Tests Inside Linux Sandbox ==="
  "$BUN_BIN" test "$PLUGIN_DIR/test/router.test.mjs" "$PLUGIN_DIR/test/realtime-parity.test.mjs" "$PLUGIN_DIR/test/sign-in-copy.test.mjs"

  echo "=== [4/4] Running Live Magpie Web + Gateway Full-Chain E2E Tests Inside Linux Sandbox ==="
  "$BUN_BIN" "$PLUGIN_DIR/test/linux-sandbox-e2e.mjs"
}

case "${1:-}" in
  --hidden-from-host)
    hide_the_host
    run_in_sandbox
    exit 0
    ;;
  --in-sandbox)
    run_in_sandbox
    exit 0
    ;;
esac

if [ -d "/mnt/c/Users/tanwei/.gemini/antigravity-cli/brain/8d5cec5e-b7a5-4cc4-bb52-1d29bd1b8676/scratch" ]; then
  SCRATCH="/mnt/c/Users/tanwei/.gemini/antigravity-cli/brain/8d5cec5e-b7a5-4cc4-bb52-1d29bd1b8676/scratch"
else
  SCRATCH="/mnt/host/c/Users/tanwei/.gemini/antigravity-cli/brain/8d5cec5e-b7a5-4cc4-bb52-1d29bd1b8676/scratch"
fi

# REPO: the checkout under test, by default the one this script is in
REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"

# Whatever way this ends, nothing of it stays: no gateway holding a real sign-in, no copy of one. busybox ash skips the EXIT
# trap on a signal, hence the other three, and the work below runs in the background so that they fire at once.
cleanup() {
  trap - EXIT TERM HUP INT
  pkill -f "$SANDBOX/" 2>/dev/null || true
  sleep 0.5
  pkill -9 -f "$SANDBOX/" 2>/dev/null || true
  rm -rf "$SANDBOX"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX/home" "$SANDBOX/config" "$SANDBOX/cache" "$SANDBOX/data" "$SANDBOX/state" "$SANDBOX/tmp" "$SANDBOX/agentcompass"
chmod 700 "$SANDBOX"

# MAGPIE_LINUX_BIN: the Magpie build under test (a release's static magpie-cli-linux-amd64, e.g. 0.1.2891)
cp "${MAGPIE_LINUX_BIN:-$SCRATCH/magpie-linux-amd64}" "$SANDBOX/magpie"
chmod +x "$SANDBOX/magpie"
cp -r "$REPO"/* "$SANDBOX/agentcompass/"
cp "$0" "$SANDBOX/run.sh"

# BASELINE_SRC: an export of the build non-realtime routing is compared with in Scenario 9, made outside the sandbox
# (it has no git): `git archive origin/main | tar -x -C <dir>`. Without it Scenario 9 is reported as skipped.
if [ -n "${BASELINE_SRC:-}" ]; then
  mkdir -p "$SANDBOX/agentcompass-main"
  cp -r "$BASELINE_SRC"/* "$SANDBOX/agentcompass-main/"
  export BASELINE_PLUGIN_DIR="$SANDBOX/agentcompass-main"
fi

if [ -f "$SCRATCH/bun-linux-musl" ]; then
  cp "$SCRATCH/bun-linux-musl" "$SANDBOX/bun"
  chmod +x "$SANDBOX/bun"
  export MAGPIE_BUN="$SANDBOX/bun"
fi

# REAL_CODEX_AUTH, REAL_CLAUDE_AUTH, REAL_GROK_AUTH: a Codex auth.json, a Claude .credentials.json and a Grok auth.json, for
# Scenario 13's real upstreams. They are only read, here, and only test/sign-in-copy.mjs's fields go in. An account with none
# is left out; with none at all Scenario 13 is reported as skipped.
HOST_SIGN_INS=""
host_files_hash() {
  # shellcheck disable=SC2086
  sha256sum $HOST_SIGN_INS | cut -d' ' -f1
}
copy_sign_in() {
  [ -n "$2" ] || return 0
  HOST_SIGN_INS="$HOST_SIGN_INS $2"
  "$SANDBOX/bun" "$PLUGIN_DIR/test/sign-in-copy.mjs" "$1" "$2" "$SANDBOX/sign-ins/$1.json"
}
if [ -n "${REAL_CODEX_AUTH:-}${REAL_CLAUDE_AUTH:-}${REAL_GROK_AUTH:-}" ]; then
  [ -x "$SANDBOX/bun" ] || { echo "[ABORT] Copying a real sign-in takes $SCRATCH/bun-linux-musl" >&2; exit 70; }
  mkdir -m 700 "$SANDBOX/sign-ins"
  copy_sign_in codex "${REAL_CODEX_AUTH:-}"
  copy_sign_in claude "${REAL_CLAUDE_AUTH:-}"
  copy_sign_in grok "${REAL_GROK_AUTH:-}"
  HASH_BEFORE=$(host_files_hash)
  unset REAL_CODEX_AUTH REAL_CLAUDE_AUTH REAL_GROK_AUTH
  export REAL_SIGN_INS_DIR="$SANDBOX/sign-ins" HOST_SIGN_INS

  # A control: from here the host is in reach, so the same checks refusing it inside the namespace mean something
  OUTSIDE_PE=no-probe
  for pe in /mnt/host/c/Windows/System32/whoami.exe /mnt/c/Windows/System32/whoami.exe; do
    if [ -f "$pe" ]; then
      cp "$pe" "$PE_PROBE"
      chmod +x "$PE_PROBE"
      if "$PE_PROBE" >/dev/null 2>&1; then OUTSIDE_PE=runs; else OUTSIDE_PE=refused; fi
      break
    fi
  done
  OUTSIDE_FILES=0
  for f in $HOST_SIGN_INS; do
    [ ! -r "$f" ] || OUTSIDE_FILES=$((OUTSIDE_FILES + 1))
  done
  echo "[Host isolation] control, outside the namespace: $OUTSIDE_FILES sign-in files readable, Windows program on tmpfs $OUTSIDE_PE"

  unshare --mount --pid --fork --kill-child --mount-proc sh "$SANDBOX/run.sh" --hidden-from-host &
else
  export SCRATCH
  sh "$SANDBOX/run.sh" --in-sandbox &
fi
wait $!

cp "$SANDBOX/e2e-report.json" "$REPO/docs/linux-sandbox-e2e-report.json"

if [ -n "$HOST_SIGN_INS" ]; then
  if [ "$(host_files_hash)" = "$HASH_BEFORE" ]; then
    # shellcheck disable=SC2086
    echo "[PASS] Host sign-in files: hashes the same before and after the run ($(echo $HOST_SIGN_INS | wc -w) files)"
  else
    # Another session on the host may have renewed its sign-in in the meantime: this says a hash changed, not why
    echo "[FAIL] Host sign-in files: a hash changed during the run" >&2
    exit 1
  fi
fi
