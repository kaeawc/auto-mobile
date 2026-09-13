#!/usr/bin/env bats

SCRIPT="scripts/android/benchmark-emulator-resources.sh"

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

write_ps_mock() {
  cat >"${MOCK_BIN}/ps" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
  *"-o command="*) printf '%s\n' 'qemu-system-x86_64 -port 5554 -accel hvf' ;;
  *"-o pid=,pcpu=,rss=,time="*) printf '%s\n' '12345 12.3 456789 00:01:02' ;;
  *) echo "unexpected ps invocation: $*" >&2; exit 99 ;;
esac
MOCK
  chmod +x "${MOCK_BIN}/ps"
}

write_adb_mock() {
  cat >"${MOCK_BIN}/adb" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ADB_LOG"
printf 'fake adb output\n'
MOCK
  chmod +x "${MOCK_BIN}/adb"
}

@test "invalid argument count exits 2 with usage on stderr" {
  run bash "$SCRIPT"

  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "invalid argument shape exits 2" {
  run bash "$SCRIPT" not-an-emulator 12345 "$OUTPUT_DIR"

  [ "$status" -eq 2 ]
  [[ "$output" != *"fake adb output"* ]]
}

@test "collects host and guest resource snapshots" {
  write_ps_mock
  write_adb_mock
  ADB_LOG="${TEST_ROOT}/adb.log"
  export ADB_LOG

  run bash "$SCRIPT" emulator-5554 12345 "$OUTPUT_DIR" 1 1

  [ "$status" -eq 0 ]
  [ "$(<"$ADB_LOG")" = $'-s emulator-5554 shell getprop\n-s emulator-5554 shell dumpsys meminfo\n-s emulator-5554 shell dumpsys battery\n-s emulator-5554 shell dumpsys meminfo\n-s emulator-5554 shell dumpsys cpuinfo\n-s emulator-5554 shell dumpsys activity processes' ]
  [ -f "${OUTPUT_DIR}/host-command.txt" ]
  [ -f "${OUTPUT_DIR}/guest-properties.txt" ]
  [ -f "${OUTPUT_DIR}/guest-memory-before.txt" ]
  [ -f "${OUTPUT_DIR}/guest-battery.txt" ]
  [ -f "${OUTPUT_DIR}/host-samples.csv" ]
  [ -f "${OUTPUT_DIR}/guest-memory-after.txt" ]
  [ -f "${OUTPUT_DIR}/guest-cpu-after.txt" ]
  [ -f "${OUTPUT_DIR}/guest-processes-after.txt" ]
  [ "$(wc -l <"${OUTPUT_DIR}/host-samples.csv" | tr -d '[:space:]')" -eq 2 ]
  grep -q '^epoch_seconds,pid,ps_cpu_percent,rss_kib,cpu_time$' "${OUTPUT_DIR}/host-samples.csv"
  grep -q ',12345,12.3,456789,00:01:02$' "${OUTPUT_DIR}/host-samples.csv"
}

@test "fails without after snapshots when the process exits during sampling" {
  cat >"${MOCK_BIN}/ps" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
  *"-o command="*) printf '%s\n' 'qemu-system-x86_64 -port 5554 -accel hvf' ;;
  *"-o pid=,pcpu=,rss=,time="*) : ;;
  *) echo "unexpected ps invocation: $*" >&2; exit 99 ;;
esac
MOCK
  chmod +x "${MOCK_BIN}/ps"
  write_adb_mock
  ADB_LOG="${TEST_ROOT}/adb.log"
  export ADB_LOG

  run bash "$SCRIPT" emulator-5554 12345 "$OUTPUT_DIR" 2 1

  [ "$status" -eq 1 ]
  [[ "$output" == *"Emulator process exited"* ]]
  [ ! -f "${OUTPUT_DIR}/guest-memory-after.txt" ]
}
