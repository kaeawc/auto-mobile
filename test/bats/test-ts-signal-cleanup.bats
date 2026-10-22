#!/usr/bin/env bats
# bats file_tags=parallel-within-file
load test-ts-process-helpers
setup() { setup_test_ts_stubs; }
teardown() { teardown_test_ts_stubs; }

signal_lane() {
  local scope="$1" signal="${2:-TERM}" expected="${3:-143}" mode="${4:-unit}" lane result=0
  # Monitor mode creates a caller group without depending on setsid (macOS).
  set -m
  local target="${5:-}"
  STUB_HOLD=1 bash scripts/test-ts.sh "$mode" ${target:+"$target"} > "$BATS_TEST_TMPDIR/lane.log" 2>&1 3>&- &
  lane=$!
  owned_pids+=("$lane")
  owned_lane_groups+=("$lane")
  set +m
  local expected_calls=2
  case "$mode" in integration|stress) expected_calls=1 ;; esac
  if [[ -n "$target" ]]; then expected_calls=1; fi
  wait_for_stub_calls "$expected_calls"
  record_lane_tree "$lane"
  if [[ "${STUB_ASSERT_SHARD_PGID:-0}" == 1 ]]; then
    local shard_root="$AUTOMOBILE_TEST_TS_COVERAGE_DIR/shards"
    if [[ "$mode" == unit ]]; then shard_root="$AUTOMOBILE_TEST_TS_SCRATCH_DIR/test-ts-unit-shards"; fi
    local pgid_files=("$shard_root"/shard-1.pgid.*)
    [[ -f "${pgid_files[0]}" ]]
    grep -q 'start$' "$STUB_CALLS.probes"
  fi
  if [[ "$scope" == group ]]; then kill -"$signal" -- "-$lane"; else kill -"$signal" "$lane"; fi
  wait "$lane" || result=$?
  [[ "$result" -eq "$expected" ]]
  assert_owned_processes_gone
  [[ ! -d "$AUTOMOBILE_COORDINATION_DIR/test-slots/0" ]]
}

@test "TERM of caller group stops commands, shard shells and watchdog sleeps" {
  signal_lane group
}

@test "TERM of only test-ts stops commands, shard shells and watchdog sleeps" {
  signal_lane pid
}

@test "INT of test-ts returns 130 and cleans up" {
  signal_lane pid INT 130
}

@test "HUP of test-ts returns 129 and cleans up" {
  signal_lane pid HUP 129
}

@test "watchdog notices its killed caller before the deadline" {
  local lane cmd watcher caller pid result=0
  export AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE="$BATS_TEST_TMPDIR/watchdog.pgid"
  STUB_HOLD=1 bash -c 'source scripts/ios/run_with_timeout.sh; run_with_timeout 600 "$STUB_BIN/bun" test' \
    > "$BATS_TEST_TMPDIR/lane.log" 2>&1 3>&- &
  lane=$!
  owned_pids+=("$lane")
  # Collect exactly this run's watcher and command groups.
  wait_for_stub_calls 1
  for file in "$AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE".*; do
    read -r cmd watcher caller < "$file"
    owned_pids+=("$cmd" "$watcher" "$caller")
  done
  while read -r pid _; do owned_pids+=("$pid"); done < "$STUB_CALLS"
  if [[ -f "$STUB_SLEEPS" ]]; then
    while read -r pid _; do owned_pids+=("$pid"); done < "$STUB_SLEEPS"
  fi
  kill -KILL "$lane"
  wait "$lane" || result=$?
  [[ "$result" -eq 137 ]]
  assert_owned_processes_gone
}

@test "group and chunk loops stop before launching another chunk after lane owner dies" {
  local helper owner supervisor result
  for helper in groups chunks; do
    : > "$STUB_CALLS"
    # kill -0 succeeds on a zombie, so the owner needs a parent that reaps it the moment it
    # dies. A supervisor that waits on it does, whatever the container's PID 1 does with
    # orphans (#14407); this shell is not that parent, so the owner is not its child.
    rm -f "$BATS_TEST_TMPDIR/owner.pid"
    bash -c 'sleep 60 > /dev/null 2>&1 & echo $! > "$1"; wait "$!"' _ "$BATS_TEST_TMPDIR/owner.pid" 3>&- &
    supervisor=$!
    until [[ -s "$BATS_TEST_TMPDIR/owner.pid" ]]; do /bin/sleep 0.01; done
    owner="$(cat "$BATS_TEST_TMPDIR/owner.pid")"
    owned_pids+=("$owner" "$supervisor")
    export AUTOMOBILE_TEST_TS_PARENT_PID="$owner"
    export STUB_KILL_PARENT=1 AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE=1
    result=0
    if [[ "$helper" == groups ]]; then
      bash scripts/lib/bun-unit-groups.sh "$PWD" Linux '' 0 test/a.test.ts test/b.test.ts || result=$?
    else
      bash scripts/lib/bun-unit-chunks.sh "$PWD" Linux 1 '' 0 test/a.test.ts test/b.test.ts || result=$?
    fi
    wait "$supervisor" 2>/dev/null || true
    [[ "$result" -ne 0 ]]
    [[ "$(wc -l < "$STUB_CALLS")" -eq 1 ]]
  done
}

@test "TERM cleanup escalates commands and descendants that ignore TERM" {
  export STUB_IGNORE_TERM=1
  signal_lane pid
}

@test "coverage shard cancellation cleans up its command and watchdog groups" {
  signal_lane pid TERM 143 coverage
}

@test "calibration-on coverage cancellation retains the held shard PGID record" {
  export AUTOMOBILE_RUNNER_CALIBRATION=1 STUB_ASSERT_SHARD_PGID=1
  signal_lane pid TERM 143 coverage
}

@test "calibration-on unit cancellation retains the held shard PGID record" {
  export AUTOMOBILE_RUNNER_CALIBRATION=1 STUB_ASSERT_SHARD_PGID=1
  signal_lane pid
}

@test "TERM interrupts integration timeout and cleans up its descendants" {
  signal_lane pid TERM 143 integration
}

@test "TERM interrupts stress timeout and cleans up its descendants" {
  signal_lane pid TERM 143 stress
}

@test "TERM of all mode cancels its active lane child" {
  signal_lane pid TERM 143 all
}

@test "TERM interrupts portable integration wait" {
  export AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1
  signal_lane pid TERM 143 integration
}

@test "TERM of all mode cancels its integration child" {
  signal_lane pid TERM 143 all test/server/proxyServerTransportFailure.integration.test.ts
}

@test "TERM of all mode cancels its stress child" {
  signal_lane pid TERM 143 all test/stress/memory-leak.stress.test.ts
}

@test "TERM interrupts gtimeout when timeout is unavailable" {
  local gtimeout_path
  gtimeout_path="$(command -v gtimeout)" || skip "gtimeout unavailable"
  ln -s "$gtimeout_path" "$STUB_BIN/gtimeout"
  export PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
  if command -v timeout >/dev/null 2>&1; then skip "system timeout cannot be hidden"; fi
  signal_lane pid TERM 143 stress
}

@test "managed native timeout preserves the command exit status" {
  cat > "$STUB_BIN/bun" <<'STUB'
#!/usr/bin/env bash
exit 7
STUB
  run bash scripts/test-ts.sh stress
  [[ "$status" -eq 7 ]]
}
