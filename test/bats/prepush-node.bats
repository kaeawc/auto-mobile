#!/usr/bin/env bats

SCRIPT="scripts/prepush-node.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  COMMAND_LOG="${MOCK_BIN}/commands.log"
  export COMMAND_LOG

  cat > "${MOCK_BIN}/git" <<'SCRIPT'
#!/bin/bash
printf 'git %s\n' "$*" >> "$COMMAND_LOG"
if [[ "$1" == "merge-base" ]]; then
  exit "${MOCK_MERGE_BASE_STATUS:-0}"
fi
SCRIPT
  chmod +x "${MOCK_BIN}/git"

  cat > "${MOCK_BIN}/bun" <<'SCRIPT'
#!/bin/bash
printf 'bun %s\n' "$*" >> "$COMMAND_LOG"
SCRIPT
  chmod +x "${MOCK_BIN}/bun"

  cat > "${MOCK_BIN}/bash" <<'SCRIPT'
#!/bin/bash
printf 'bash %s\n' "$*" >> "$COMMAND_LOG"
SCRIPT
  chmod +x "${MOCK_BIN}/bash"

  cat > "${MOCK_BIN}/env" <<'SCRIPT'
#!/bin/bash
if [[ "$*" == *"AUTOMOBILE_TEST_MODE=true"* || "$*" == *"BUN_TEST_TIMING_BASE_REF=origin/main"* ]]; then
  printf 'env %s\n' "$*" >> "$COMMAND_LOG"
fi
exec /usr/bin/env "$@"
SCRIPT
  chmod +x "${MOCK_BIN}/env"

  cat > "${MOCK_BIN}/uname" <<'SCRIPT'
#!/bin/bash
printf '%s\n' "${MOCK_UNAME:-Linux}"
SCRIPT
  chmod +x "${MOCK_BIN}/uname"
}

teardown() {
  rm -rf "$MOCK_BIN"
}

@test "runs Node gates in fail-fast order" {
  run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$COMMAND_LOG")" = $'git fetch --quiet origin main\ngit merge-base --is-ancestor origin/main HEAD\nbun run format:check\nbun run typecheck\nbun run lint\nbun test test/lint/\nbun run test:image:bun\nenv AUTOMOBILE_TEST_MODE=true AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720 AUTOMOBILE_UNIT_JUNIT_DIR=scratch/timing-unit-reports bash scripts/test-ts.sh unit\nbash scripts/test-ts.sh unit\nenv BUN_TEST_TIMING_BASE_REF=origin/main BUN_TEST_TIMING_REPORT_DIR=scratch/timing-unit-reports bash scripts/validate-bun-test-timings.sh\nbash scripts/validate-bun-test-timings.sh' ]
  [[ "$output" == *"Node pre-push validation passed"* ]]
}

@test "changed mode uses the existing changed-test lane" {
  run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed

  [ "$status" -eq 0 ]
  grep -Fx 'bun run test:image:bun' "$COMMAND_LOG"
  grep -Fx 'bash scripts/test-ts.sh changed' "$COMMAND_LOG"
  grep -Fx 'bash scripts/validate-bun-test-timings.sh' "$COMMAND_LOG"
}

@test "Windows keeps the wall-timeout opt-out" {
  run env -u RUNNER_OS MOCK_UNAME=MINGW64_NT-10.0 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  ! grep -F 'AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720' "$COMMAND_LOG"
  grep -Fx 'env AUTOMOBILE_TEST_MODE=true AUTOMOBILE_UNIT_JUNIT_DIR=scratch/timing-unit-reports bash scripts/test-ts.sh unit' "$COMMAND_LOG"
  ! grep -F 'validate-bun-test-timings.sh' "$COMMAND_LOG"
}

@test "macOS skips timing by default and --timing forces it" {
  run env -u RUNNER_OS MOCK_UNAME=Darwin PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping unit timing budget gate on macOS; CI only runs it on Linux. Pass --timing to force it locally."* ]]
  ! grep -F 'validate-bun-test-timings.sh' "$COMMAND_LOG"

  : > "$COMMAND_LOG"
  run env -u RUNNER_OS MOCK_UNAME=Darwin PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --timing --changed

  [ "$status" -eq 0 ]
  grep -Fx 'bash scripts/validate-bun-test-timings.sh' "$COMMAND_LOG"
}

@test "stale base stops before local gates" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_MERGE_BASE_STATUS=1 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"does not contain origin/main"* ]]
  [ "$(cat "$COMMAND_LOG")" = $'git fetch --quiet origin main\ngit merge-base --is-ancestor origin/main HEAD' ]
}
