#!/usr/bin/env bats
# bats file_tags=serial,integration
# This test exercises GNU Parallel's real timeout and process-tree reaping. Keep
# it out of the cross-file-parallel unit lane; run it serially in integration.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ci/run-bats.sh"
  STUB_BIN="$(mktemp -d)"
  FIXTURES="$(mktemp -d)"
  ARGS_FILE="$(mktemp)"

  cat > "$STUB_BIN/bats" <<EOF
#!/usr/bin/env bash
printf 'bats:%s\\n' "\$1" >> "$ARGS_FILE"
sleep 30 &
printf '%s\\n' "\$!" > "\${TIMEOUT_SLEEP_PID_FILE}"
wait \$!
EOF
  chmod +x "$STUB_BIN/bats"
}

teardown() {
  if [[ -s "$FIXTURES/sleep.pid" ]]; then
    sleep_pid="$(cat "$FIXTURES/sleep.pid")"
    if kill -0 "$sleep_pid" 2>/dev/null; then
      kill "$sleep_pid" 2>/dev/null || true
    fi
  fi
  rm -rf "$STUB_BIN" "$FIXTURES"
  rm -f "$ARGS_FILE"
}

@test "GNU Parallel kills a timed-out BATS process tree and names its file" {
  local timeout_bin real_bin list_file
  command -v parallel >/dev/null || skip "GNU Parallel is unavailable"
  parallel --version | head -1 | grep -q 'GNU parallel' || skip "GNU Parallel is unavailable"
  timeout_bin="$(command -v gtimeout || command -v timeout)" || skip "timeout is unavailable"
  real_bin="$(mktemp -d)"
  ln -s "$(command -v parallel)" "$real_bin/parallel"
  list_file="$FIXTURES/timeout-list"
  printf '%s\0' "$FIXTURES/parallel-timeout.bats" > "$list_file"

  run "$timeout_bin" -k 2s 8s env \
    PATH="$real_bin:$STUB_BIN:$PATH" \
    AUTOMOBILE_BATS_MAX_FILE_SECONDS=1 \
    TIMEOUT_SLEEP_PID_FILE="$FIXTURES/sleep.pid" \
    bash -c 'source "$1"; run_parallel_files "$2" 1 "$3"' \
    _ "$SCRIPT" "$list_file" "$FIXTURES/timeout-joblog.tsv"

  rm -rf "$real_bin"
  [ "$status" -ne 0 ]
  [ "$status" -ne 124 ]
  [ "$status" -ne 137 ]
  [[ "$output" == *"$FIXTURES/parallel-timeout.bats exceeded 1s and was killed"* ]]
  grep -q "^bats:$FIXTURES/parallel-timeout.bats$" "$ARGS_FILE"
  [ -s "$FIXTURES/sleep.pid" ]
  ! kill -0 "$(cat "$FIXTURES/sleep.pid")" 2>/dev/null
}
