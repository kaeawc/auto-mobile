#!/usr/bin/env bats
#
# Tests for scripts/ci/daemon-lifecycle.sh
#
# Regression guard for #3640: the lifecycle script must fail when `--daemon
# start` or `--daemon health` fails. Previously (no `set -e`, no PIPESTATUS
# check) those failures were swallowed and the script's exit status reflected
# only the final `stop`, so the CI step passed green even when the daemon
# never started.

SCRIPT="scripts/ci/daemon-lifecycle.sh"

setup() {
  # Resolve absolute script path before we cd elsewhere (bats cwd = repo root).
  SCRIPT_ABS="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  STUB_DIR="$(mktemp -d)"
  WORK_DIR="$(mktemp -d)"

  # Stub `bun`: fails the subcommand named in $FAIL_ON (e.g. "start"),
  # returns 7 for `--cli doctor` (normal on device-less CI), else succeeds.
  cat > "$STUB_DIR/bun" <<'EOF'
#!/usr/bin/env bash
if [ -n "${FAIL_ON:-}" ] && [[ "$*" == *"--daemon ${FAIL_ON}"* ]]; then
  echo "stub bun: failing ${FAIL_ON}" >&2
  exit 1
fi
if [[ "$*" == *"--cli doctor"* ]]; then
  echo "stub bun: doctor found no devices" >&2
  exit 7
fi
echo "stub bun: ok $*"
exit 0
EOF
  chmod +x "$STUB_DIR/bun"
}

teardown() {
  rm -rf "$STUB_DIR" "$WORK_DIR"
}

# HOME points at an empty dir so the script's `${HOME}/.bun/bin` PATH prefix
# is a no-op and our stub `bun` wins.
run_lifecycle() {
  cd "$WORK_DIR"
  run env HOME="$WORK_DIR" PATH="$STUB_DIR:/usr/bin:/bin" "$@" bash "$SCRIPT_ABS"
}

@test "succeeds when start, health, and stop all succeed (doctor non-zero tolerated)" {
  run_lifecycle
  [ "$status" -eq 0 ]
}

@test "fails when daemon start fails" {
  run_lifecycle FAIL_ON=start
  [ "$status" -ne 0 ]
  [[ "$output" == *"daemon start failed"* ]]
}

@test "fails when daemon health fails" {
  run_lifecycle FAIL_ON=health
  [ "$status" -ne 0 ]
  [[ "$output" == *"daemon health check failed"* ]]
}
