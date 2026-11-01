#!/usr/bin/env bats
# All CLI operations are stubbed; no device or daemon is touched.
# Bats runs each test independently; exported overrides are local to that test.
# shellcheck disable=SC2030,SC2031

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  export TEST_DIR="$BATS_TEST_TMPDIR/session-release"
  mkdir -p "$TEST_DIR/bin" "$TEST_DIR/override"
  export CALLS="$TEST_DIR/calls"
  : > "$CALLS"
  export PATH="$TEST_DIR/bin:$PATH"
  unset AUTO_MOBILE_CMD RELEASE_FAILS
  local stub
  for stub in "$TEST_DIR/bin/auto-mobile" "$TEST_DIR/override/cli.sh"; do
    cat > "$stub" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s timeout=%s\n' "${0##*/}" "$*" "${AUTOMOBILE_DAEMON_TIMEOUT_MS:-}" >> "$CALLS"
[[ "${RELEASE_FAILS:-0}" == 0 ]]
STUB
    chmod +x "$stub"
  done
  cat > "$TEST_DIR/override/bun-like" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'bun-like %s\n' "$*" >> "$CALLS"
exec bash "$@"
STUB
  chmod +x "$TEST_DIR/override/bun-like"
}

run_release() {
  run bash -c '
    set -euo pipefail
    source "$1/scripts/lib/session-release.sh"
    session_release_uuid=test-session
    session_release_done=0
    session_release_on_exit 2> "$TEST_DIR/stderr"
  ' bash "$ROOT"
}

@test "release uses override outside PATH and drops its CLI flags" {
  export AUTO_MOBILE_CMD="$TEST_DIR/override/cli.sh --debug --embedded-sdk --cli"
  run_release
  [ "$status" -eq 0 ]
  [ "$(cat "$CALLS")" = 'cli.sh --daemon release-session test-session timeout=2000' ]
}

@test "release preserves interpreter and script before the first long option" {
  export AUTO_MOBILE_CMD="$TEST_DIR/override/bun-like $TEST_DIR/override/cli.sh --debug --cli"
  run_release
  [ "$status" -eq 0 ]
  [ "$(cat "$CALLS")" = "bun-like $TEST_DIR/override/cli.sh --daemon release-session test-session
cli.sh --daemon release-session test-session timeout=2000" ]
}

@test "release uses PATH auto-mobile when override is unset" {
  run_release
  [ "$status" -eq 0 ]
  [ "$(cat "$CALLS")" = 'auto-mobile --daemon release-session test-session timeout=2000' ]
}

@test "release uses PATH auto-mobile when override is empty" {
  export AUTO_MOBILE_CMD=''
  run_release
  [ "$status" -eq 0 ]
  [ "$(cat "$CALLS")" = 'auto-mobile --daemon release-session test-session timeout=2000' ]
}

@test "failed release warns on stderr and preserves the original exit status" {
  export RELEASE_FAILS=1
  run_release
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ "$(cat "$TEST_DIR/stderr")" = 'warning: could not release session test-session' ]
  [ "$(cat "$CALLS")" = 'auto-mobile --daemon release-session test-session timeout=2000' ]
}
