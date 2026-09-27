#!/usr/bin/env bats
# bats file_tags=serial,integration

SCRIPT="scripts/test-ts.sh"

@test "real Bun integration stall is identified and its process is killed" {
  local pid_file timing_log stalled_pid
  pid_file="$(mktemp)"
  timing_log="$(mktemp)"
  run env AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=5 \
    AUTOMOBILE_INTEGRATION_STALL_PID_FILE="$pid_file" \
    AUTOMOBILE_TEST_TIMING_LOG="$timing_log" \
    AUTOMOBILE_WATCHDOG_TIMING_LOG="$timing_log" \
    bash "$SCRIPT" integration test/fixtures/integrationRunnerProbe.integration.test.ts
  [ "$status" -eq 124 ]
  [[ "$output" == *"test/fixtures/integrationRunnerProbe.integration.test.ts"* ]]
  stalled_pid="$(cat "$pid_file")"
  [[ "$stalled_pid" =~ ^[0-9]+$ ]]
  ! kill -0 "$stalled_pid" 2> /dev/null
  rm -f "$pid_file" "$timing_log"
}
