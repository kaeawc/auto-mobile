#!/usr/bin/env bats
#
# Tests for scripts/ci/install-fast-validation-deps.sh
#
# The real script installs xmlstarlet + bats over the network. These tests stub
# `sudo`, `apt-get`, and `git` on PATH so nothing touches the network, and drive
# the timeout/retry logic that bounds the Fast Validation dependency-install
# hang class.

SCRIPT="scripts/ci/install-fast-validation-deps.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  # A shared counter file lets a stub fail the first N invocations.
  export STATE_FILE="${MOCK_BIN}/apt-calls"
  # Keep the bats source-install branch out of the way: a stub `bats` on PATH
  # makes the script skip cloning bats-core.
  cat > "${MOCK_BIN}/bats" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "${MOCK_BIN}/bats"
  # `sudo` just drops the sudo and execs the rest.
  cat > "${MOCK_BIN}/sudo" <<'STUB'
#!/usr/bin/env bash
exec "$@"
STUB
  chmod +x "${MOCK_BIN}/sudo"
  # A hermetic GNU-`timeout` emulation so these tests do not depend on the host
  # shipping coreutils `timeout` (macOS does not). Supports `[-k GRACE] DURATION
  # CMD...` and returns 124 when it has to kill the command, matching the real
  # tool the script relies on in Ubuntu CI.
  cat > "${MOCK_BIN}/timeout" <<'STUB'
#!/usr/bin/env bash
grace=""
if [ "$1" = "-k" ]; then grace="$2"; shift 2; fi
duration="$1"; shift
# Sentinel recording that the killer actually fired. Checking the killer with
# `kill -0` is racy: an exited-but-unreaped killer is a zombie, and `kill -0`
# on a zombie still succeeds, which made this stub report the command's raw
# exit (commonly 143) instead of 124.
fired="$(mktemp -u)"
"$@" &
cmd_pid=$!
(
  sleep "$duration"
  # Mark BEFORE signaling so the parent cannot observe the kill without the
  # sentinel; un-mark if the command was already gone (natural exit won the
  # race and must keep its own status).
  : > "$fired"
  if ! kill -TERM "$cmd_pid" 2>/dev/null; then
    rm -f "$fired"
  elif [ -n "$grace" ]; then
    sleep "$grace"
    kill -KILL "$cmd_pid" 2>/dev/null
  fi
) &
killer_pid=$!
if wait "$cmd_pid" 2>/dev/null; then status=0; else status=$?; fi
# Reap the killer and its `sleep` child either way so nothing orphaned holds
# the output pipe open.
pkill -P "$killer_pid" 2>/dev/null
kill "$killer_pid" 2>/dev/null
wait "$killer_pid" 2>/dev/null
if [ -e "$fired" ] && [ "$status" -ne 0 ]; then
  # Timed out: reap any grandchild of the killed command (e.g. a `sleep`).
  pkill -P "$cmd_pid" 2>/dev/null
  rm -f "$fired"
  exit 124
fi
rm -f "$fired"
exit "$status"
STUB
  chmod +x "${MOCK_BIN}/timeout"
  export PATH="${MOCK_BIN}:${PATH}"
  # Fast, deterministic retries.
  export FAST_VALIDATION_DEPS_RETRY_BASE_DELAY_SECONDS=1
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

# Writes an `apt-get` stub that fails its first $1 invocations, then succeeds.
make_apt_get() {
  local fail_first="$1"
  cat > "${MOCK_BIN}/apt-get" <<STUB
#!/usr/bin/env bash
calls=0
[ -f "${STATE_FILE}" ] && calls="\$(cat "${STATE_FILE}")"
calls=\$((calls + 1))
echo "\$calls" > "${STATE_FILE}"
if [ "\$calls" -le "${fail_first}" ]; then
  echo "apt-get transient failure \$calls" >&2
  exit 100
fi
exit 0
STUB
  chmod +x "${MOCK_BIN}/apt-get"
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "script has bash shebang" {
  head -1 "$SCRIPT" | grep -q "bash"
}

@test "shellcheck passes" {
  if ! command -v shellcheck > /dev/null 2>&1; then
    skip "shellcheck not installed"
  fi
  run shellcheck "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "succeeds when all network commands succeed" {
  make_apt_get 0
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Fast Validation dependencies ready"* ]]
}

@test "retries a transiently-failing apt-get and then succeeds" {
  # First `apt-get update` call fails once, then succeeds; install then succeeds.
  make_apt_get 1
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"attempt 2/2"* ]]
  [[ "$output" == *"Fast Validation dependencies ready"* ]]
}

@test "default retry budget fits the 10-minute step timeout" {
  # Worst case = 4 ops x (MAX_ATTEMPTS x (CMD_TIMEOUT + KILL_GRACE) + delays).
  # Guard the arithmetic so a future default bump cannot silently exceed the
  # workflow step's timeout-minutes backstop.
  local cmd_timeout kill_grace attempts base_delay
  cmd_timeout=$(grep -oE 'CMD_TIMEOUT_SECONDS:-[0-9]+' "$SCRIPT" | grep -oE '[0-9]+$')
  kill_grace=$(grep -oE 'KILL_GRACE_SECONDS:-[0-9]+' "$SCRIPT" | grep -oE '[0-9]+$')
  attempts=$(grep -oE 'MAX_ATTEMPTS:-[0-9]+' "$SCRIPT" | grep -oE '[0-9]+$')
  base_delay=$(grep -oE 'RETRY_BASE_DELAY_SECONDS:-[0-9]+' "$SCRIPT" | grep -oE '[0-9]+$')
  local delays=0 delay="$base_delay" i
  for ((i = 1; i < attempts; i++)); do
    delays=$((delays + delay))
    delay=$((delay * 2))
  done
  local worst_case=$((4 * (attempts * (cmd_timeout + kill_grace) + delays)))
  echo "worst_case=${worst_case}s"
  [ "$worst_case" -le 600 ]
}

@test "a partial clone left by a killed attempt is cleaned before the retry" {
  # Force the source-install branch: drop the `bats` stub and restrict PATH so
  # the host's real bats (typically /usr/local or homebrew) is not found, while
  # our git/sudo/timeout stubs still win.
  rm "${MOCK_BIN}/bats"
  make_apt_get 0
  local clone_dir="${MOCK_BIN}/bats-clone"
  export CLONE_STATE="${MOCK_BIN}/git-calls"
  # First clone "dies mid-transfer": leaves a non-empty target and fails.
  # Second clone must see a CLEAN target (proving per-attempt cleanup) — it
  # fails loudly like real git if the directory still exists.
  cat > "${MOCK_BIN}/git" <<STUB
#!/usr/bin/env bash
target="\${!#}"
calls=0
[ -f "${CLONE_STATE}" ] && calls="\$(cat "${CLONE_STATE}")"
calls=\$((calls + 1))
echo "\$calls" > "${CLONE_STATE}"
if [ "\$calls" -eq 1 ]; then
  mkdir -p "\$target"
  echo partial > "\$target/partial-object"
  exit 1
fi
if [ -e "\$target" ]; then
  echo "fatal: destination path '\$target' already exists and is not an empty directory." >&2
  exit 128
fi
mkdir -p "\$target"
printf '#!/usr/bin/env bash\nexit 0\n' > "\$target/install.sh"
chmod +x "\$target/install.sh"
exit 0
STUB
  chmod +x "${MOCK_BIN}/git"
  run env PATH="${MOCK_BIN}:/usr/bin:/bin" \
    FAST_VALIDATION_DEPS_BATS_CLONE_DIR="$clone_dir" \
    bash "$SCRIPT"
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"attempt 2/2"* ]]
  [[ "$output" == *"Fast Validation dependencies ready"* ]]
}

@test "fails loudly after exhausting retries" {
  # apt-get fails more times than MAX_ATTEMPTS allows.
  make_apt_get 99
  run env FAST_VALIDATION_DEPS_MAX_ATTEMPTS=2 bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"failed after 2 attempts"* ]]
}

@test "bounds a hanging command with the per-command timeout" {
  # apt-get sleeps far longer than the 1s per-command timeout; with a single
  # attempt the run must fail fast (via exit 124) rather than block.
  cat > "${MOCK_BIN}/apt-get" <<'STUB'
#!/usr/bin/env bash
sleep 30
STUB
  chmod +x "${MOCK_BIN}/apt-get"
  run env FAST_VALIDATION_DEPS_CMD_TIMEOUT_SECONDS=1 \
    FAST_VALIDATION_DEPS_KILL_GRACE_SECONDS=1 \
    FAST_VALIDATION_DEPS_MAX_ATTEMPTS=1 \
    bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"timed out after 1s"* ]]
}

@test "rejects a non-positive-integer tunable" {
  make_apt_get 0
  run env FAST_VALIDATION_DEPS_MAX_ATTEMPTS=0 bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"must be a positive integer"* ]]
}
