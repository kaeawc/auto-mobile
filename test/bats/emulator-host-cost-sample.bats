#!/usr/bin/env bats

SCRIPT="scripts/android/emulator-host-cost-sample.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  MOCK_BIN="${TEST_ROOT}/bin"
  OUTPUT_DIR="${TEST_ROOT}/output"
  mkdir -p "$MOCK_BIN"
  ORIG_PATH="$PATH"
  export PATH="${MOCK_BIN}:${PATH}"
}

teardown() {
  export PATH="$ORIG_PATH"
  rm -rf "$TEST_ROOT"
}

# Each call advances the cumulative CPU time by ten seconds.
write_ps_mock() {
  cat >"${MOCK_BIN}/ps" <<MOCK
#!/usr/bin/env bash
case "\$*" in
  *"-o command="*) printf '%s\n' '${1:-qemu-system-aarch64 -port 5554}' ;;
  *"-o time="*)
    count=\$(( \$(cat "${TEST_ROOT}/calls" 2>/dev/null || echo 0) + 1 ))
    echo "\$count" >"${TEST_ROOT}/calls"
    printf '  0:%02d.00\n' \$(( count * 10 ))
    ;;
  *) echo "unexpected ps invocation: \$*" >&2; exit 99 ;;
esac
MOCK
  chmod +x "${MOCK_BIN}/ps"
}

write_footprint_mock() {
  cat >"${MOCK_BIN}/footprint" <<'MOCK'
#!/usr/bin/env bash
printf 'qemu-system-aarch64 [4242]: 64-bit    Footprint: %s (16384 bytes per page)\n' "${COST_FOOTPRINT:-2 GB}"
MOCK
  chmod +x "${MOCK_BIN}/footprint"
}

@test "wrong argument count exits 2 with usage" {
  run bash "$SCRIPT"

  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "a process that is not an emulator is refused" {
  write_ps_mock 'bash -c sleep'

  run bash "$SCRIPT" 4242 "$OUTPUT_DIR" 1 1

  [ "$status" -eq 2 ]
  [[ "$output" == *"not an emulator process"* ]]
}

@test "macOS records cumulative CPU seconds and footprint, and summarises the window" {
  write_ps_mock
  write_footprint_mock
  export COST_UNAME=Darwin

  run bash "$SCRIPT" 4242 "$OUTPUT_DIR" 3 1

  [ "$status" -eq 0 ]
  grep -q '^epoch_seconds,cpu_seconds,unique_kib$' "${OUTPUT_DIR}/cost-samples.csv"
  [ "$(wc -l <"${OUTPUT_DIR}/cost-samples.csv" | tr -d '[:space:]')" -eq 4 ]
  grep -q ',10.00,2097152$' "${OUTPUT_DIR}/cost-samples.csv"
  grep -q ',30.00,2097152$' "${OUTPUT_DIR}/cost-samples.csv"
  grep -q '^cpu_seconds_delta=20.00$' "${OUTPUT_DIR}/cost-summary.txt"
  grep -q '^unique_kib_peak=2097152$' "${OUTPUT_DIR}/cost-summary.txt"
  grep -q '^unique_memory_method=footprint' "${OUTPUT_DIR}/cost-summary.txt"
  [ -f "${OUTPUT_DIR}/host-command.txt" ]
}

@test "footprint units MB and KB convert to KiB" {
  write_ps_mock
  write_footprint_mock
  export COST_UNAME=Darwin

  COST_FOOTPRINT="512 MB" run bash "$SCRIPT" 4242 "$OUTPUT_DIR" 1 1

  [ "$status" -eq 0 ]
  grep -q ',524288$' "${OUTPUT_DIR}/cost-samples.csv"
}

@test "Linux reads the proportional set size from smaps_rollup" {
  write_ps_mock
  mkdir -p "${TEST_ROOT}/proc/4242"
  printf 'Rss:             900000 kB\nPss:             123456 kB\n' >"${TEST_ROOT}/proc/4242/smaps_rollup"
  export COST_UNAME=Linux COST_PROC_ROOT="${TEST_ROOT}/proc"

  run bash "$SCRIPT" 4242 "$OUTPUT_DIR" 2 1

  [ "$status" -eq 0 ]
  grep -q ',123456$' "${OUTPUT_DIR}/cost-samples.csv"
  grep -q '^unique_memory_method=smaps_rollup Pss$' "${OUTPUT_DIR}/cost-summary.txt"
}

@test "an unreadable memory source fails instead of writing a guess" {
  write_ps_mock
  export COST_UNAME=Linux COST_PROC_ROOT="${TEST_ROOT}/missing"

  run bash "$SCRIPT" 4242 "$OUTPUT_DIR" 1 1

  [ "$status" -eq 1 ]
  [[ "$output" == *"Could not read unique memory"* ]]
}

@test "ps time formats with days and hours convert to seconds" {
  run bash -c 'source scripts/android/emulator-host-cost-sample.sh; cpu_seconds_from_ps_time 1-02:03:04.50; echo; cpu_seconds_from_ps_time 12:34:56; echo; cpu_seconds_from_ps_time 0:01.25'

  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "93784.50" ]
  [ "${lines[1]}" = "45296.00" ]
  [ "${lines[2]}" = "1.25" ]
}
