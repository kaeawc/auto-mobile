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
if [ "$1" = "-k" ]; then shift 2; fi
duration="$1"; shift
"$@" &
cmd_pid=$!
( sleep "$duration"; kill -TERM "$cmd_pid" 2>/dev/null ) &
killer_pid=$!
if wait "$cmd_pid" 2>/dev/null; then status=0; else status=$?; fi
if kill -0 "$killer_pid" 2>/dev/null; then
  # Command finished first: cancel the killer and reap its `sleep` child so it
  # is not orphaned (an orphaned long `sleep` would hold the output pipe open).
  pkill -P "$killer_pid" 2>/dev/null
  kill "$killer_pid" 2>/dev/null
  wait "$killer_pid" 2>/dev/null
  exit "$status"
fi
# Timed out: reap any grandchild of the killed command (e.g. a `sleep`).
pkill -P "$cmd_pid" 2>/dev/null
exit 124
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
  [[ "$output" == *"attempt 2/3"* ]]
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
