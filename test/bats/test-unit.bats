#!/usr/bin/env bats
#
# Tests for scripts/test-unit.sh. A PATH shim records its Bun invocation while
# the timeout shim immediately executes the wrapped command.

SCRIPT="scripts/test-unit.sh"

setup() {
  STUB_BIN="$(mktemp -d)"

  cat > "$STUB_BIN/timeout" <<'TIMEOUT'
#!/usr/bin/env bash
printf 'timeout=%s\n' "$3"
shift 2
shift
exec "$@"
TIMEOUT

  cat > "$STUB_BIN/bun" <<'BUN'
#!/usr/bin/env bash
printf '%s\n' "$*"
BUN

  chmod +x "$STUB_BIN/timeout" "$STUB_BIN/bun"
}

teardown() {
  rm -rf "$STUB_BIN"
}

run_unit_tests() {
  run env PATH="$STUB_BIN:$PATH" "$@" bash "$SCRIPT"
}

@test "runs the complete unit suite by default" {
  run_unit_tests
  [ "$status" -eq 0 ]
  [[ "$output" == *"test --timeout 5000 --no-orphans --parallel=12"* ]]
  [[ "$output" == *"--path-ignore-patterns test/integration/*.test.ts"* ]]
  [[ "$output" != *"--changed="* ]]
}

@test "keeps Windows tests out of isolated parallel mode" {
  run_unit_tests RUNNER_OS=Windows
  [ "$status" -eq 0 ]
  [[ "$output" == *"test --timeout 5000 --no-orphans"* ]]
  [[ "$output" != *"--parallel="* ]]
}

@test "gives macOS tests per-test and wall-clock headroom" {
  run_unit_tests RUNNER_OS=macOS
  [ "$status" -eq 0 ]
  [[ "$output" == *"timeout=720"* ]]
  [[ "$output" == *"test --timeout 20000 --no-orphans --parallel=12"* ]]
}

@test "forwards explicit changed-test selection" {
  run env PATH="$STUB_BIN:$PATH" bash "$SCRIPT" --changed=origin/main
  [ "$status" -eq 0 ]
  [[ "$output" == *"--changed=origin/main"* ]]
}
