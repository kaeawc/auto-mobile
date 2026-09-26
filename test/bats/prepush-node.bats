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
if [[ "$1" == "diff" && "$2" == "--no-renames" && "$3" == "--name-only" ]]; then
  if [[ -n "${MOCK_CHANGED_FILES_DIFF_STATUS:-}" ]]; then
    exit "$MOCK_CHANGED_FILES_DIFF_STATUS"
  fi
  if [[ -n "${MOCK_CHANGED_FILES:-}" ]]; then
    printf '%s\n' "$MOCK_CHANGED_FILES"
  fi
fi
if [[ "$1" == "diff" && "$2" == "--no-renames" && "$4" == "--diff-filter=ACMRD" && -n "${MOCK_WORKTREE_CHANGED_FILES:-}" ]]; then
  printf '%s\n' "$MOCK_WORKTREE_CHANGED_FILES"
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
  expected_log=$'git fetch --quiet origin main\ngit merge-base --is-ancestor origin/main HEAD\nbun run format:check\nbun run typecheck\nbun run lint\nbun test test/lint/\nbun run test:image:bun\nenv AUTOMOBILE_TEST_MODE=true AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720 AUTOMOBILE_UNIT_JUNIT_DIR=scratch/timing-unit-reports bash scripts/test-ts.sh unit\nbash scripts/test-ts.sh unit\ngit diff --no-renames --name-only origin/main...HEAD --\ngit diff --no-renames --cached --name-only --diff-filter=ACMRD\ngit diff --no-renames --name-only --diff-filter=ACMRD\nenv BUN_TEST_TIMING_BASE_REF=origin/main BUN_TEST_TIMING_REPORT_DIR=scratch/timing-unit-reports bash scripts/validate-bun-test-timings.sh\nbash scripts/validate-bun-test-timings.sh'
  [ "$(cat "$COMMAND_LOG")" = "$expected_log" ] || {
    printf 'Expected:\n%s\nActual:\n%s\n' "$expected_log" "$(cat "$COMMAND_LOG")"
    return 1
  }
  [[ "$output" == *"Node pre-push validation passed"* ]]
}

@test "DB integration fast path runs for each selected directory" {
  local changed_file
  for changed_file in src/daemon/session.ts src/db/store.ts src/server/api.ts test/db/query.integration.test.ts; do
    : > "$COMMAND_LOG"
    run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES="$changed_file" PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

    [ "$status" -eq 0 ]
    [ "$(grep -c '^bun test test/db/.*\.integration\.test\.ts' "$COMMAND_LOG")" -eq 1 ]
    grep -F 'env AUTOMOBILE_TEST_MODE=true bun test test/db/' "$COMMAND_LOG"
    [[ "$output" == *"PASS"*"test/db integration fast path"* ]]
  done
}

@test "DB integration fast path skips unrelated changes" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES=src/tools/observe.ts PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping test/db integration fast path; no changes under src/daemon/, src/db/, src/server/, or test/db/."* ]]
  ! grep -F 'bun test test/db/' "$COMMAND_LOG"
  [[ "$output" == *"PASS"*"test/db integration fast path"* ]]
}

@test "DB integration fast path sees tracked worktree changes" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_WORKTREE_CHANGED_FILES=src/db/local.ts PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(grep -c '^bun test test/db/.*\.integration\.test\.ts' "$COMMAND_LOG")" -eq 1 ]
}

@test "DB integration fast path fails when branch diff fails" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES_DIFF_STATUS=2 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL"*"test/db integration fast path"* ]]
  ! grep -F 'bun test test/db/' "$COMMAND_LOG"
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
