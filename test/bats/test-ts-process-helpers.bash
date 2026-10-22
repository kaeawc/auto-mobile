# Shared hermetic fixtures for test-ts process/slot tests. No real Bun suites.
setup_test_ts_stubs() {
  export AUTOMOBILE_TEST_TS_COVERAGE_DIR="$BATS_TEST_TMPDIR/coverage"
  export AUTOMOBILE_TEST_TS_SCRATCH_DIR="$BATS_TEST_TMPDIR/scratch"
  export AUTOMOBILE_COORDINATION_DIR="$BATS_TEST_TMPDIR/coordination"
  export AUTOMOBILE_UNIT_TEST_WORKERS=2 AUTOMOBILE_UNIT_SHARD_RETRIES=0
  export AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=600 AUTOMOBILE_RUNNER_CALIBRATION=0
  export AUTOMOBILE_WATCHDOG_KILL_GRACE_SECONDS=0.1
  export AUTOMOBILE_UNIT_SHARED_ALLOWLIST="$BATS_TEST_TMPDIR/allowlist"
  export AUTOMOBILE_TEST_LOADAVG_FILE="$BATS_TEST_TMPDIR/loadavg"
  export STUB_SLEEPS="$BATS_TEST_TMPDIR/sleeps"
  export STUB_CALLS="$BATS_TEST_TMPDIR/calls"
  export STUB_BIN="$BATS_TEST_TMPDIR/bin"
  unset AUTOMOBILE_HOST_TEST_SLOTS AUTOMOBILE_UNIT_RANDOM_SEED AUTOMOBILE_UNIT_TEST_CHUNK_FILES
  unset AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE AUTOMOBILE_TEST_TS_PARENT_PID RUNNER_OS
  unset AUTOMOBILE_CHANGED_SELECT_TIMEOUT_SECONDS
  mkdir -p "$STUB_BIN"
  : > "$AUTOMOBILE_UNIT_SHARED_ALLOWLIST"
  echo 0 > "$AUTOMOBILE_TEST_LOADAVG_FILE"
  cat > "$STUB_BIN/bun" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == */scripts/lib/changedUnitTests.ts ]]; then
  printf '%s\n' "$2" >> "$STUB_CALLS.selection"
  printf '%s\n' "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" > "$STUB_CALLS.selection-timeout"
  if [[ "${STUB_SELECTION_HOLD:-}" == 1 ]]; then sleep 60; fi
  for ((i=0; i<${STUB_SELECTED_COUNT:-12}; i+=1)); do printf 'test/fixture%02d.test.ts\n' "$i"; done
  exit "${STUB_SELECTION_STATUS:-0}"
fi
if [[ "$1" == */scripts/lib/runner-calibration.ts && "$2" == probe ]]; then
  printf '%s\n' "$4" >> "$STUB_CALLS.probes"
  printf '%s\t75\t25\n' "$4" >> "$3"
  exit 0
fi
if [[ "$1" == --config=* ]]; then shift; fi
[[ "$1" == test ]] || exit 0
if [[ -n "${AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE:-}" ]]; then exit 99; fi
printf '%s %s\n' "$$" "$*" >> "$STUB_CALLS"
printf '%s\n' "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" >> "$STUB_CALLS.test-timeout"
if [[ "${STUB_KILL_PARENT:-}" == 1 ]]; then
  kill -TERM "$AUTOMOBILE_TEST_TS_PARENT_PID"
  # The owner's supervisor reaps it asynchronously. Until then it is a zombie
  # and the helper's `kill -0` still succeeds, so return only once the owner
  # is fully gone (bounded, ~10 s).
  for ((reap_poll = 0; reap_poll < 200; reap_poll += 1)); do
    kill -0 "$AUTOMOBILE_TEST_TS_PARENT_PID" 2>/dev/null || break
    /bin/sleep 0.05
  done
  if kill -0 "$AUTOMOBILE_TEST_TS_PARENT_PID" 2>/dev/null; then
    echo "stub bun: owner $AUTOMOBILE_TEST_TS_PARENT_PID was never reaped" >&2
    exit 98
  fi
fi
if [[ "${STUB_IGNORE_TERM:-}" == 1 ]]; then trap '' TERM; fi
if [[ "${STUB_HOLD:-}" == 1 ]]; then sleep 60; fi
if [[ "${STUB_TIMEOUT_ONCE:-}" == 1 && ! -e "$STUB_CALLS.once" ]]; then
  touch "$STUB_CALLS.once"
  exit 124
fi
STUB
  cat > "$STUB_BIN/find" <<'STUB'
#!/usr/bin/env bash
for ((i=0; i<12; i+=1)); do printf 'test/fixture%02d.test.ts\n' "$i"; done
STUB
  cat > "$STUB_BIN/nproc" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${STUB_CORES:-8}"
STUB
  cat > "$STUB_BIN/sysctl" <<'STUB'
#!/usr/bin/env bash
if [[ "$2" == vm.loadavg ]]; then echo '{ 0 0 0 }'; else echo 8; fi
STUB
  cat > "$STUB_BIN/sleep" <<'STUB'
#!/usr/bin/env bash
if [[ "${STUB_HOLD:-}" == 1 ]]; then printf '%s %s\n' "$$" "$*" >> "$STUB_SLEEPS"; fi
exec /bin/sleep "$@"
STUB
  # Exercise the stock macOS Bash 3.2 for every script and stub, while Bats
  # itself keeps its modern interpreter. /bin/bash also exists on Linux.
  cat > "$STUB_BIN/bash" <<'STUB'
#!/bin/bash
exec /bin/bash "$@"
STUB
  chmod +x "$STUB_BIN/"*
  export PATH="$STUB_BIN:$PATH"
  owned_pids=()
  owned_lane_groups=()
}

# Record the lane and its complete tree, including separately grouped commands
# and watchdog sleeps, BEFORE signalling. Teardown only signals this PID list.
record_lane_tree() {
  local lane="$1" file cmd watcher caller pid
  owned_pids+=("$lane")
  for file in "$AUTOMOBILE_TEST_TS_SCRATCH_DIR"/test-ts-pgid.*.* \
    "$AUTOMOBILE_TEST_TS_SCRATCH_DIR"/test-ts-unit-shards/*.pgid.* \
    "$AUTOMOBILE_TEST_TS_COVERAGE_DIR"/shards/*.pgid.*; do
    [[ -f "$file" ]] || continue
    read -r cmd watcher caller < "$file"
    owned_pids+=("$cmd" "$watcher" "$caller")
  done
  while read -r pid _; do owned_pids+=("$pid"); done < "$STUB_CALLS"
  if [[ -f "$STUB_SLEEPS" ]]; then
    while read -r pid _; do owned_pids+=("$pid"); done < "$STUB_SLEEPS"
  fi
}

wait_for_stub_calls() {
  local count="${1:-2}" attempt
  for ((attempt=0; attempt<60; attempt+=1)); do
    if [[ -f "$STUB_CALLS" && "$(wc -l < "$STUB_CALLS")" -ge "$count" && -f "$STUB_SLEEPS" ]]; then
      # Wait for the sleeping descendants too, so none can launch between the
      # PID census and the signal without being covered by the assertions.
      if [[ "$(awk '$2 == 60 {n++} END {print n+0}' "$STUB_SLEEPS")" -ge "$count" ]]; then return 0; fi
    fi
    sleep 0.05
  done
  cat "$BATS_TEST_TMPDIR/lane.log" >&2 || true
  return 1
}

assert_owned_processes_gone() {
  local attempt pid live
  for ((attempt=0; attempt<60; attempt+=1)); do
    live=0
    for pid in ${owned_pids[@]+"${owned_pids[@]}"}; do
      if kill -0 "$pid" 2>/dev/null; then live=1; fi
    done
    if [[ "$live" -eq 0 ]]; then return 0; fi
    sleep 0.05
  done
  for pid in ${owned_pids[@]+"${owned_pids[@]}"}; do
    if kill -0 "$pid" 2>/dev/null; then printf 'Process still present: %s\n' "$pid" >&2; fi
  done
  cat "$BATS_TEST_TMPDIR/lane.log" >&2 || true
  return 1
}

teardown_test_ts_stubs() {
  local pid
  for pid in ${owned_lane_groups[@]+"${owned_lane_groups[@]}"}; do
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for pid in ${owned_pids[@]+"${owned_pids[@]}"}; do kill -KILL "$pid" 2>/dev/null || true; done
  for pid in ${owned_pids[@]+"${owned_pids[@]}"}; do wait "$pid" 2>/dev/null || true; done
}
