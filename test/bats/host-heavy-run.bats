#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# scripts/lib/host-heavy-run.sh: Go checkers (tsgo, tsgolint) run under the host slot pool (#13910).

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  export AUTOMOBILE_COORDINATION_DIR="$BATS_TEST_TMPDIR/coordination"
  mkdir -p "$AUTOMOBILE_COORDINATION_DIR"
  unset GOMAXPROCS AUTOMOBILE_HEAVY_CHECK_SLOTS AUTOMOBILE_HEAVY_CHECK_WAIT_SECONDS
  export AUTOMOBILE_HOST_TEST_SLOTS=4
  holder=""
}

teardown() {
  if [[ -n "$holder" ]]; then
    touch "$BATS_TEST_TMPDIR/holder.release"
    wait "$holder" 2> /dev/null || true
  fi
}

# Runs `host_heavy_run "$@"` in a fresh shell, as the gate scripts do.
heavy() {
  bash -c 'source scripts/lib/host-heavy-run.sh; host_heavy_run "$@"' bash "$@"
}

# Holds $1 slots from the shared pool until teardown.
hold() {
  bash -c '
    source scripts/lib/host-slots.sh
    trap host_slots_release EXIT
    trap "exit 143" TERM
    host_slots_acquire "$1" 4
    echo "$host_slots_acquired" > "$2"
    while [[ ! -f "$2.release" ]]; do sleep 0.05; done
  ' bash "$1" "$BATS_TEST_TMPDIR/holder" > /dev/null 2>&1 3>&- &
  holder=$!
  local attempt
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    [[ -f "$BATS_TEST_TMPDIR/holder" ]] && return 0
    sleep 0.05
  done
  return 1
}

@test "a lone run gets its slots and keeps the tool's default parallelism" {
  cd "$REPO_ROOT"
  run heavy bash -c 'echo "gomaxprocs=${GOMAXPROCS:-unset}"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"gomaxprocs=unset"* ]]
  [[ "$output" != *"capping checker threads"* ]]
}

@test "slots are released after the run so the next run is also uncapped" {
  cd "$REPO_ROOT"
  run heavy true
  [ "$status" -eq 0 ]
  run heavy bash -c 'echo "gomaxprocs=${GOMAXPROCS:-unset}"'
  [[ "$output" == *"gomaxprocs=unset"* ]]
}

@test "a contended pool caps the checker's threads to the slots acquired" {
  cd "$REPO_ROOT"
  hold 3
  run heavy bash -c 'echo "gomaxprocs=${GOMAXPROCS:-unset}"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"gomaxprocs=1"* ]]
  [[ "$output" == *"capping checker threads to 1"* ]]
}

@test "an exhausted pool waits then proceeds with one thread" {
  cd "$REPO_ROOT"
  hold 4
  AUTOMOBILE_HEAVY_CHECK_WAIT_SECONDS=0 run heavy bash -c 'echo "gomaxprocs=${GOMAXPROCS:-unset}"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"gomaxprocs=1"* ]]
}

@test "a run that got every slot it asked for is still capped while another run holds the pool" {
  cd "$REPO_ROOT"
  hold 2
  AUTOMOBILE_HEAVY_CHECK_SLOTS=2 run heavy bash -c 'echo "gomaxprocs=${GOMAXPROCS:-unset}"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"gomaxprocs=2"* ]]
}

@test "the thread cap is the command's last argument, empty for a lone run" {
  cd "$REPO_ROOT"
  run heavy bash -c 'echo "threads=[$1]"' _
  [[ "$output" == *"threads=[]"* ]]
  hold 3
  run heavy bash -c 'echo "threads=[$1]"' _
  [[ "$output" == *"threads=[1]"* ]]
}

@test "the pool is empty again after a run and after a killed run" {
  cd "$REPO_ROOT"
  run heavy true
  [ -z "$(ls -A "$AUTOMOBILE_COORDINATION_DIR/test-slots" 2> /dev/null)" ]
  heavy sleep 2 &
  local runner=$!
  local attempt
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    [[ -n "$(ls -A "$AUTOMOBILE_COORDINATION_DIR/test-slots" 2> /dev/null)" ]] && break
    sleep 0.05
  done
  # The slots belong to the run until its checker ends, even if the starter is signalled.
  kill -TERM "$runner"
  wait "$runner" || true
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    [[ -z "$(ls -A "$AUTOMOBILE_COORDINATION_DIR/test-slots" 2> /dev/null)" ]] && break
    sleep 0.1
  done
  [ -z "$(ls -A "$AUTOMOBILE_COORDINATION_DIR/test-slots" 2> /dev/null)" ]
}

@test "waiting for a full pool is announced" {
  cd "$REPO_ROOT"
  hold 4
  AUTOMOBILE_HEAVY_CHECK_WAIT_SECONDS=0 run heavy true
  [ "$status" -eq 0 ]
  [[ "$output" == *"capping checker threads to 1"* ]]
}

@test "AUTOMOBILE_HOST_TEST_SLOTS=off disables the cap" {
  cd "$REPO_ROOT"
  hold 4
  AUTOMOBILE_HOST_TEST_SLOTS=off run heavy bash -c 'echo "gomaxprocs=${GOMAXPROCS:-unset}"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"gomaxprocs=unset"* ]]
}

@test "the command's exit status propagates and its slots are still released" {
  cd "$REPO_ROOT"
  run heavy bash -c 'exit 7'
  [ "$status" -eq 7 ]
  run heavy bash -c 'echo "gomaxprocs=${GOMAXPROCS:-unset}"'
  [[ "$output" == *"gomaxprocs=unset"* ]]
}

@test "an invalid slot demand is refused" {
  cd "$REPO_ROOT"
  AUTOMOBILE_HEAVY_CHECK_SLOTS=zero run heavy true
  [ "$status" -eq 2 ]
  [[ "$output" == *"AUTOMOBILE_HEAVY_CHECK_SLOTS must be a positive integer"* ]]
}
