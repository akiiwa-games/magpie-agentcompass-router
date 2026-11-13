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

# Takes the host out of sight of Scenario 13 before dropping to nobody: the host's drives and the mounts of its files, the way
# back through interop, /tmp/.X11-unix, and (being in its own PID namespace) /proc/<pid>/root of what runs outside.
hide_the_host() {
  cd /
  # /etc/resolv.conf points into a directory hidden below
  resolv_at=$(readlink -f /etc/resolv.conf)
  resolv=$(cat /etc/resolv.conf)
  for d in /mnt/* /mnt/host/* /run/WSL /tmp/.X11-unix $(awk "$HOST_MOUNTS" /proc/mounts); do
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
  old_ifs=$IFS
  IFS='
'
  set -f
  for f in $HOST_SIGN_INS; do
    [ ! -e "$f" ] || abort "a sign-in file is visible"
    [ ! -e "/proc/1/root$f" ] || abort "a sign-in file is visible through /proc"
  done
  set +f
  IFS=$old_ifs
  for d in /mnt/* /mnt/host/*; do
    [ -d "$d" ] && [ "$d" != /mnt/host ] && [ "$d" != "$(dirname "$resolv_at")" ] || continue
    [ -z "$(ls -A "$d")" ] || abort "$d is readable"
  done
  [ ! -e /tmp/.X11-unix/X0 ] && [ -z "$(ls -A /tmp/.X11-unix 2>/dev/null)" ] || abort "/tmp/.X11-unix is readable"
  [ -z "$(awk "$HOST_MOUNTS" /proc/mounts)" ] || abort "a mount of the host's files is left"
  for cmd in /mnt/host/c/Windows/System32/cmd.exe /mnt/c/Windows/System32/cmd.exe; do
    ! "$cmd" /c exit 0 >/dev/null 2>&1 || abort "$cmd runs"
  done
  pe=no-probe
  if [ -f "$PE_PROBE" ]; then
    ! "$PE_PROBE" >/dev/null 2>&1 || abort "a Windows program runs on the host from the sandbox's own files"
    pe=refused
  fi
  unset HOST_SIGN_INS
  export MAGPIE_HOST_HIDDEN=1 MAGPIE_PE_PROBE_RESULT="$pe"
}

# Verified after su to nobody: non-root cannot lift a mask, mount a host drive back, or write a kernel hook, and RLIMIT_CORE=1:1
# stops /wsl-capture-crash from writing a core dump to %TEMP%\wsl-crashes on the host.
verify_unprivileged_sandbox() {
  abort() {
    echo "[ABORT] The host is still in reach, so no real sign-in may run here: $1" >&2
    exit 70
  }
  uid=$(id -u)
  [ "$uid" != 0 ] || abort "sandbox is still running as root (uid 0)"
  awk '/^Max core file size/ { ok = ($5 == 1 && $6 == 1) } END { exit !ok }' /proc/self/limits || abort "RLIMIT_CORE is not 1:1"
  [ ! -e /tmp/.X11-unix/X0 ] && [ -z "$(ls -A /tmp/.X11-unix 2>/dev/null)" ] || abort "/tmp/.X11-unix is visible"
  ! umount /run/WSL 2>/dev/null || abort "umount /run/WSL succeeded inside the sandbox"
  ! umount -l /run/WSL 2>/dev/null || abort "umount -l /run/WSL succeeded inside the sandbox"
  mkdir -p "$SANDBOX/tmp/drvfs-probe"
  if /sbin/mount.drvfs 'C:\' "$SANDBOX/tmp/drvfs-probe" >/dev/null 2>&1 || mount -t 9p none "$SANDBOX/tmp/drvfs-probe" >/dev/null 2>&1; then
    abort "mount.drvfs succeeded inside the sandbox"
  fi
  rmdir "$SANDBOX/tmp/drvfs-probe"
  for hook in /proc/sys/kernel/core_pattern /proc/sys/kernel/modprobe /sys/kernel/uevent_helper; do
    [ -e "$hook" ] || continue
    cur=$(cat "$hook" 2>/dev/null || true)
    if (printf '%s\n' "$cur" > "$hook") 2>/dev/null; then
      abort "$hook is writable inside the sandbox"
    fi
  done
  # C1 regression probe: crash a child holding a fake token in env and heap; the outer script verifies 0 dumps in %TEMP%\wsl-crashes
  FAKE_CRASH_TOKEN="sk-ant-oat01-FAKE_CRASH_CANARY_0123456789abcdef" sh -c 'kill -SEGV $$' >/dev/null 2>&1 || true
  if [ -x "$SANDBOX/bun" ]; then
    FAKE_CRASH_TOKEN="sk-ant-oat01-FAKE_CRASH_CANARY_0123456789abcdef" "$SANDBOX/bun" -e 'globalThis.keep = Buffer.from("FAKE_CRASH_CANARY_HEAP_" + "0123456789".repeat(8)); process.kill(process.pid, "SIGABRT");' >/dev/null 2>&1 || true
  fi
  sleep 1
  pe="${MAGPIE_PE_PROBE_RESULT:-no-probe}"
  printf '{"signInFilesVisible":false,"hostDrivesReadable":false,"hostMountsLeft":0,"x11SocketVisible":false,"cmdExe":"refused","windowsProgramOnTmpfs":"%s","pidNamespace":true,"uid":%s,"coreLimit":"1:1","mountDrvfs":"refused","umountWsl":"refused","writeCorePattern":"refused"}\n' "$pe" "$uid" > "$SANDBOX/isolation.json"
  echo "[Host isolation] inside the namespace (uid=$uid, core=1:1): sign-in files gone, host drives empty, no host mounts, X11 masked, cmd.exe refused, Windows program on tmpfs $pe, mount.drvfs refused, umount /run/WSL refused, core_pattern refused"
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
  "$BUN_BIN" test "$PLUGIN_DIR/test/router.test.mjs" "$PLUGIN_DIR/test/no-hardcode.test.mjs" "$PLUGIN_DIR/test/sign-in-copy.test.mjs"

  echo "=== [4/4] Running Live Magpie Web + Gateway Full-Chain E2E Tests Inside Linux Sandbox ==="
  "$BUN_BIN" "$PLUGIN_DIR/test/linux-sandbox-e2e.mjs"
}

case "${1:-}" in
  --hidden-from-host)
    hide_the_host
    chown -R nobody "$SANDBOX"
    exec su -p -s /bin/sh nobody -c "sh \"$SANDBOX/run.sh\" --in-sandbox"
    ;;
  --selftest-hidden)
    hide_the_host >/dev/null
    chown -R nobody "$SANDBOX"
    exec su -p -s /bin/sh nobody -c "sh \"$SANDBOX/run.sh\" --selftest-nobody"
    ;;
  --selftest-nobody)
    verify_unprivileged_sandbox >/dev/null
    exit 0
    ;;
  --in-sandbox)
    if [ "${MAGPIE_HOST_HIDDEN:-}" = 1 ]; then
      verify_unprivileged_sandbox
    fi
    run_in_sandbox
    exit 0
    ;;
esac

if [ -d "/mnt/c/Users/tanwei/.gemini/antigravity-cli/brain/8d5cec5e-b7a5-4cc4-bb52-1d29bd1b8676/scratch" ]; then
  WIN_HOST="/mnt/c"
else
  WIN_HOST="/mnt/host/c"
fi
SCRATCH="$WIN_HOST/Users/tanwei/.gemini/antigravity-cli/brain/8d5cec5e-b7a5-4cc4-bb52-1d29bd1b8676/scratch"
WIN_TMP="$WIN_HOST/Users/tanwei/AppData/Local/Temp"
WSL_CRASH_DIR="${WSL_CRASH_DIR:-$WIN_TMP/wsl-crashes}"
CRASH_DIR_EXISTED=0
CRASHES_BEFORE=""
if [ -d "$WSL_CRASH_DIR" ]; then
  CRASH_DIR_EXISTED=1
  CRASHES_BEFORE=$(ls -A "$WSL_CRASH_DIR" 2>/dev/null || true)
fi

new_crash_dumps_count() {
  count=0
  if [ -d "$WSL_CRASH_DIR" ]; then
    for path in "$WSL_CRASH_DIR"/* "$WSL_CRASH_DIR"/.[!.]* "$WSL_CRASH_DIR"/..?*; do
      [ -e "$path" ] || continue
      f=$(basename "$path")
      if ! printf '%s\n' "$CRASHES_BEFORE" | grep -Fqx "$f"; then
        count=$((count + 1))
      fi
    done
  fi
  printf '%s\n' "$count"
}

# REPO: the checkout under test, by default the one this script is in
REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"

# Whatever way this ends, nothing of it stays: no gateway holding a real sign-in, no copy of one, and no crash dump written by
# /wsl-capture-crash to %TEMP%\wsl-crashes during this run. busybox ash skips the EXIT trap on a signal, hence the other three,
# and the work below runs in the background so that they fire at once.
cleanup() {
  trap - EXIT TERM HUP INT
  pkill -f "$SANDBOX/" 2>/dev/null || true
  sleep 0.5
  pkill -9 -f "$SANDBOX/" 2>/dev/null || true
  rm -rf "$SANDBOX" "${SELFTEST_HOST_DIR:-}"
  crashes_removed=0
  if [ -d "$WSL_CRASH_DIR" ]; then
    for path in "$WSL_CRASH_DIR"/* "$WSL_CRASH_DIR"/.[!.]* "$WSL_CRASH_DIR"/..?*; do
      [ -e "$path" ] || continue
      f=$(basename "$path")
      if ! printf '%s\n' "$CRASHES_BEFORE" | grep -Fqx "$f"; then
        rm -rf "$path"
        crashes_removed=$((crashes_removed + 1))
      fi
    done
    if [ "$CRASH_DIR_EXISTED" = 0 ]; then
      rmdir "$WSL_CRASH_DIR" 2>/dev/null || true
    fi
  fi
  echo "[Cleanup] %TEMP%\\wsl-crashes dumps from this run removed: $crashes_removed"
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
HOST_SIGN_IN_COUNT=0
host_files_hash() {
  [ -n "$HOST_SIGN_INS" ] || return 1
  old_ifs=$IFS
  IFS='
'
  set -f
  for f in $HOST_SIGN_INS; do
    set +f
    IFS=$old_ifs
    sum_line=$(sha256sum "$f") || return 1
    printf '%s\n' "${sum_line%% *}"
    IFS='
'
    set -f
  done
  set +f
  IFS=$old_ifs
}
copy_sign_in() {
  [ -n "$2" ] || return 0
  case "$2" in
    *'
'*)
      echo "[ABORT] Sign-in path must not contain a newline" >&2
      exit 70
      ;;
  esac
  HOST_SIGN_INS="${HOST_SIGN_INS}${HOST_SIGN_INS:+
}$2"
  HOST_SIGN_IN_COUNT=$((HOST_SIGN_IN_COUNT + 1))
  "$SANDBOX/bun" "$PLUGIN_DIR/test/sign-in-copy.mjs" "$1" "$2" "$SANDBOX/sign-ins/$1.json"
}

# Reproducible regression check for C1 (fake-token crash produces 0 dumps in %TEMP%\wsl-crashes), C2 (nobody cannot mount.drvfs,
# umount /run/WSL, write core_pattern or see /tmp/.X11-unix), and C5 (sign-in path with spaces hashes and isolates properly).
run_isolation_and_hash_selftest() {
  [ -x "$SANDBOX/bun" ] && [ -d "$WIN_TMP" ] || return 0
  SELFTEST_HOST_DIR="$WIN_TMP/magpie sandbox selftest $$"
  SELFTEST_FILE="$SELFTEST_HOST_DIR/fake codex sign-in.json"
  mkdir -p "$SELFTEST_HOST_DIR" "$SANDBOX/sign-ins"
  printf '{"tokens":{"access_token":"sk-fake-selftest-token-0123456789abcdef0123456789abcdef","refresh_token":"rt_fake_selftest_0123456789abcdef0123456789abcdef"}}\n' > "$SELFTEST_FILE"

  HOST_SIGN_INS=""
  HOST_SIGN_IN_COUNT=0
  copy_sign_in codex "$SELFTEST_FILE" >/dev/null
  st_hash_before=$(host_files_hash)
  [ -n "$st_hash_before" ] || { echo "[FAIL] C5 self-test: empty hash for path with spaces" >&2; exit 1; }

  if (HOST_SIGN_INS="$SELFTEST_HOST_DIR/missing file.json"; host_files_hash >/dev/null 2>&1); then
    echo "[FAIL] C5 self-test: missing path with spaces did not fail host_files_hash" >&2
    exit 1
  fi

  (
    export HOST_SIGN_INS MAGPIE_PE_PROBE_RESULT="no-probe"
    prlimit --core=1:1 unshare --mount --pid --fork --kill-child --mount-proc sh "$SANDBOX/run.sh" --selftest-hidden
  )
  chown -R 0:0 "$SANDBOX"
  rm -rf "$SANDBOX/sign-ins" "$SANDBOX/isolation.json"

  st_crashes=$(new_crash_dumps_count)
  if [ "$st_crashes" != 0 ]; then
    echo "[FAIL] C1 self-test: fake-token crash produced $st_crashes dump(s) in %TEMP%\\wsl-crashes" >&2
    exit 1
  fi

  st_hash_after=$(host_files_hash)
  if [ "$st_hash_after" != "$st_hash_before" ] || [ "$HOST_SIGN_IN_COUNT" != 1 ]; then
    echo "[FAIL] C5 self-test: hash mismatch on path with spaces" >&2
    exit 1
  fi

  printf '{"tokens":{"access_token":"sk-fake-selftest-changed-0123456789abcdef0123456789abcdef"}}\n' > "$SELFTEST_FILE"
  st_hash_changed=$(host_files_hash)
  if [ "$st_hash_changed" = "$st_hash_before" ]; then
    echo "[FAIL] C5 self-test: mutated file at path with spaces kept the same hash" >&2
    exit 1
  fi

  rm -rf "$SELFTEST_HOST_DIR"
  SELFTEST_HOST_DIR=""
  HOST_SIGN_INS=""
  HOST_SIGN_IN_COUNT=0
  echo "[PASS] Sandbox regression checks: C1 fake-token crash dumps=0, C2 nobody/mount.drvfs/umount/core_pattern/X11 refused, C5 path-with-spaces hash verified"
}
run_isolation_and_hash_selftest

export PLUGIN_COMMIT="${PLUGIN_COMMIT:-}" BASELINE_COMMIT="${BASELINE_COMMIT:-}"

if [ -n "${REAL_CODEX_AUTH:-}${REAL_CLAUDE_AUTH:-}${REAL_GROK_AUTH:-}" ]; then
  prlimit --pid $$ --core=1:1
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
  old_ifs=$IFS
  IFS='
'
  set -f
  for f in $HOST_SIGN_INS; do
    [ ! -r "$f" ] || OUTSIDE_FILES=$((OUTSIDE_FILES + 1))
  done
  set +f
  IFS=$old_ifs
  echo "[Host isolation] control, outside the namespace: $OUTSIDE_FILES sign-in files readable, Windows program on tmpfs $OUTSIDE_PE"

  unshare --mount --pid --fork --kill-child --mount-proc sh "$SANDBOX/run.sh" --hidden-from-host &
else
  export SCRATCH
  sh "$SANDBOX/run.sh" --in-sandbox &
fi
e2e_rc=0
wait $! || e2e_rc=$?

if [ -f "$SANDBOX/e2e-report.json" ]; then
  cp "$SANDBOX/e2e-report.json" "${REPORT_OUT:-$REPO/docs/linux-sandbox-e2e-report.json}"
fi

if [ -n "$HOST_SIGN_INS" ]; then
  crashes_now=$(new_crash_dumps_count)
  if [ "$crashes_now" = 0 ]; then
    echo "[PASS] Crash dump check: 0 dumps in %TEMP%\\wsl-crashes"
  else
    echo "[FAIL] Crash dump check: $crashes_now dump(s) written to %TEMP%\\wsl-crashes" >&2
    exit 1
  fi
  if HASH_AFTER=$(host_files_hash) && [ -n "$HASH_BEFORE" ] && [ "$HASH_AFTER" = "$HASH_BEFORE" ]; then
    echo "[PASS] Host sign-in files: hashes the same before and after the run ($HOST_SIGN_IN_COUNT files)"
  else
    # Another session on the host may have renewed its sign-in in the meantime: this says a hash changed, not why
    echo "[FAIL] Host sign-in files: a hash changed during the run" >&2
    exit 1
  fi
fi

exit "$e2e_rc"
