#!/usr/bin/env bats
# bats file_tags=parallel-within-file
load test-ts-process-helpers
setup() { setup_test_ts_stubs; }
teardown() { teardown_test_ts_stubs; }

slot_probe() {
  bash -c '
    source scripts/lib/host-slots.sh
    trap host_slots_release EXIT
    host_slots_acquire "$1" "$2" || exit $?
    echo "slots=$host_slots_acquired"
  ' bash "$1" "${2:-8}"
}

hold_slots() {
  local demand="$1"
  bash -c '
    source scripts/lib/host-slots.sh
    trap host_slots_release EXIT
    trap "exit 143" TERM
    host_slots_acquire "$1" 8
    echo "$host_slots_acquired" > "$2"
    while [[ ! -f "$2.release" ]]; do sleep 0.05; done
  ' bash "$demand" "$BATS_TEST_TMPDIR/holder" > "$BATS_TEST_TMPDIR/holder.log" 2>&1 3>&- &
  holder=$!
  owned_pids+=("$holder")
  local attempt
  for ((attempt=0; attempt<60; attempt+=1)); do
    [[ -f "$BATS_TEST_TMPDIR/holder" ]] && return 0
    sleep 0.05
  done
  return 1
}

release_holder() {
  touch "$BATS_TEST_TMPDIR/holder.release"
  wait "$holder"
}

@test "sole holder gets full demand above the base pool and releases on exit" {
  export AUTOMOBILE_HOST_TEST_SLOTS=2
  run slot_probe 6
  [[ "$status" -eq 0 && "$output" == 'slots=6' ]]
  [[ ! -d "$AUTOMOBILE_COORDINATION_DIR/test-slots/0" ]]
  [[ ! -d "$AUTOMOBILE_COORDINATION_DIR/test-slots/5" ]]
}

@test "concurrent lanes split available base slots; partial holder gets no extras" {
  export AUTOMOBILE_HOST_TEST_SLOTS=4
  hold_slots 2
  [[ "$(cat "$BATS_TEST_TMPDIR/holder")" -eq 2 ]]
  run slot_probe 6
  [[ "$status" -eq 0 && "$output" == 'slots=2' ]]
  release_holder
}

@test "zero slots still runs one unslotted worker and releases nothing owned by another lane" {
  export AUTOMOBILE_HOST_TEST_SLOTS=2
  hold_slots 2
  run bash scripts/test-ts.sh unit
  [[ "$status" -eq 0 ]]
  [[ "$output" == *'host slots demand=2 acquired=0 workers=1'* ]]
  [[ "$output" == *'unit shard 1/1'* ]]
  [[ -d "$AUTOMOBILE_COORDINATION_DIR/test-slots/0" ]]
  release_holder
}

@test "dead owners are reclaimed and live owners remain untouched" {
  local path="$AUTOMOBILE_COORDINATION_DIR/test-slots/0" dead
  # Obtain a genuinely dead PID, rather than assuming a high PID is unused.
  bash -c ':' & dead=$!; wait "$dead"
  mkdir -p "$path"
  echo "$dead" > "$path/owner.pid"
  export AUTOMOBILE_HOST_TEST_SLOTS=1
  run slot_probe 1
  [[ "$status" -eq 0 && "$output" == 'slots=1' ]]
  [[ ! -d "$path" ]]
  mkdir -p "$path"
  echo "$$" > "$path/owner.pid"
  run slot_probe 1
  [[ "$status" -eq 0 && "$output" == 'slots=0' ]]
  [[ "$(cat "$path/owner.pid")" == "$$" ]]
}

@test "default pool is ceil cores over two with a two-slot minimum" {
  hold_slots 2
  run slot_probe 8 8
  [[ "$status" -eq 0 && "$output" == 'slots=2' ]]
  run slot_probe 8 1
  [[ "$status" -eq 0 && "$output" == 'slots=0' ]]
  release_holder
}

@test "off disables the pool and invalid capacity fails before bun" {
  export AUTOMOBILE_HOST_TEST_SLOTS=off
  run slot_probe 6
  [[ "$status" -eq 0 && "$output" == 'slots=6' ]]
  [[ ! -d "$AUTOMOBILE_COORDINATION_DIR/test-slots" ]]
  local invalid
  for invalid in 0 -1 1.5 nonsense; do
    run env AUTOMOBILE_HOST_TEST_SLOTS="$invalid" bash scripts/test-ts.sh unit
    [[ "$status" -eq 2 && "$output" == *'AUTOMOBILE_HOST_TEST_SLOTS must be a positive integer'* ]]
  done
  [[ ! -e "$STUB_CALLS" ]]
}

@test "targeted parallelism is bounded by file count independently of worker demand" {
  run env TEST_TS_PRINT_CMD=1 AUTOMOBILE_UNIT_TEST_WORKERS=6 bash scripts/test-ts.sh unit test/scripts/testLaneClassification.test.ts
  [[ "$status" -eq 0 && "$output" == *'--parallel=1'* ]]
  run env TEST_TS_PRINT_CMD=1 AUTOMOBILE_UNIT_TEST_WORKERS=6 bash scripts/test-ts.sh unit test/scripts/testLaneClassification.test.ts test/scripts/classifySharedSafe.test.ts
  [[ "$status" -eq 0 && "$output" == *'--parallel=2'* ]]
  [[ ! -e "$STUB_CALLS" ]]
}

@test "targeted parallelism also respects slots left by another lane" {
  export AUTOMOBILE_HOST_TEST_SLOTS=3
  hold_slots 2
  run env TEST_TS_PRINT_CMD=1 bash scripts/test-ts.sh unit test/scripts/testLaneClassification.test.ts test/scripts/classifySharedSafe.test.ts
  [[ "$status" -eq 0 && "$output" == *'--parallel=1'* ]]
  [[ "$output" == *'host slots demand=2 acquired=1 workers=1'* ]]
  release_holder
}

@test "changed mode chunks the explicit selection with the capped worker count" {
  export AUTOMOBILE_HOST_TEST_SLOTS=2
  hold_slots 2
  run bash scripts/test-ts.sh changed
  [[ "$status" -eq 0 && "$output" == *'host slots demand=2 acquired=0 workers=1'* ]]
  grep -q -- 'test/fixture00.test.ts' "$STUB_CALLS"
  ! grep -q -- '--changed=\|--shard=' "$STUB_CALLS"
  [[ "$(wc -l < "$STUB_CALLS")" -eq 1 ]]
  release_holder
}

@test "timeout retry is suppressed above core count but preserved on a calm host" {
  export AUTOMOBILE_UNIT_TEST_WORKERS=1 AUTOMOBILE_UNIT_SHARD_RETRIES=1 STUB_TIMEOUT_ONCE=1
  echo 9.25 > "$AUTOMOBILE_TEST_LOADAVG_FILE"
  run bash scripts/test-ts.sh unit
  [[ "$status" -eq 124 ]]
  [[ "$output" == *'not retrying unit shard 0: host load 9.25 > cores 8'* ]]
  [[ "$(wc -l < "$STUB_CALLS")" -eq 1 ]]
  rm -f "$STUB_CALLS" "$STUB_CALLS.once"
  echo 8.0 > "$AUTOMOBILE_TEST_LOADAVG_FILE"
  run bash scripts/test-ts.sh unit
  [[ "$status" -eq 0 && "$output" == *'passed on its retry'* ]]
  [[ "$(wc -l < "$STUB_CALLS")" -eq 2 ]]
}

@test "reclaimer rechecks a cached dead owner and leaves an unpublished replacement alone" {
  local path="$AUTOMOBILE_COORDINATION_DIR/test-slots/0" dead
  bash -c ':' & dead=$!; wait "$dead"
  mkdir -p "$path"
  echo "$dead" > "$path/owner.pid"
  run env AUTOMOBILE_HOST_TEST_SLOTS=1 bash -c '
    source scripts/lib/host-slots.sh
    trap host_slots_release EXIT
    target="$AUTOMOBILE_COORDINATION_DIR/test-slots/0"
    mkdir() {
      command mkdir "$@" || return $?
      if [[ "$1" == "$target/reclaim" ]]; then
        # A replacement won after the first read, before the recovery claim;
        # its PID is not published yet. Do not remove/recreate its directory.
        rm -f "$target/owner.pid"
      fi
    }
    host_slots_acquire 1 8
    echo "slots=$host_slots_acquired"
  '
  [[ "$status" -eq 0 && "$output" == 'slots=0' ]]
  [[ -d "$path" && ! -e "$path/owner.pid" && ! -d "$path/reclaim" ]]
}

@test "fresh unpublished slots are protected; stale unpublished slots recover full parity" {
  local path="$AUTOMOBILE_COORDINATION_DIR/test-slots/0"
  export AUTOMOBILE_HOST_TEST_SLOTS=1
  mkdir -p "$path"
  run slot_probe 4
  [[ "$status" -eq 0 && "$output" == 'slots=0' ]]
  touch -t 200001010000 "$path"
  run slot_probe 4
  [[ "$status" -eq 0 && "$output" == 'slots=4' ]]
  [[ ! -d "$path" ]]
}

@test "stale abandoned reclaim claims recover; fresh reclaim claims are protected" {
  local path="$AUTOMOBILE_COORDINATION_DIR/test-slots/0" dead
  bash -c ':' & dead=$!; wait "$dead"
  export AUTOMOBILE_HOST_TEST_SLOTS=1
  mkdir -p "$path/reclaim"
  echo "$dead" > "$path/owner.pid"
  run slot_probe 4
  [[ "$status" -eq 0 && "$output" == 'slots=0' ]]
  touch -t 200001010000 "$path/reclaim"
  run slot_probe 4
  [[ "$status" -eq 0 && "$output" == 'slots=4' ]]
  [[ ! -d "$path" ]]
}

@test "release leaves slots whose owner changed untouched" {
  run bash -c '
    source scripts/lib/host-slots.sh
    host_slots_acquire 1 8
    path="${host_slot_paths[0]}"
    echo "$PPID" > "$path/owner.pid"
    host_slots_release
    [[ "$(cat "$path/owner.pid")" == "$PPID" ]]
  '
  [[ "$status" -eq 0 ]]
}

@test "unwritable coordination pool warns and runs uncapped" {
  # A regular file blocks mkdir even when tests run as root.
  touch "$BATS_TEST_TMPDIR/blocked"
  export AUTOMOBILE_COORDINATION_DIR="$BATS_TEST_TMPDIR/blocked"
  run slot_probe 6
  [[ "$status" -eq 0 && "$output" == *'warning: cannot create host slot pool'* ]]
  [[ "$output" == *'running uncapped'* && "$output" == *'slots=6'* ]]
}
