#!/usr/bin/env bats

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/android/collect-emulator-diagnostics.sh"
  FAKE_BIN="$BATS_TEST_TMPDIR/bin"
  DIAGNOSTICS="$BATS_TEST_TMPDIR/diagnostics"
  mkdir -p "$FAKE_BIN" "$DIAGNOSTICS" "$BATS_TEST_TMPDIR/avd" "$BATS_TEST_TMPDIR/tmp"
  # Isolate PATH, including the missing-adb case, from installed SDK tools.
  for command in bash dirname mkdir awk ls cat tail chmod env rm; do
    ln -s "$(command -v "$command")" "$FAKE_BIN/$command"
  done
  cat > "$FAKE_BIN/timeout" <<'SHIM'
#!/usr/bin/env bash
shift 3
"$@"
SHIM
  for command in ps df free; do
    cat > "$FAKE_BIN/$command" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' '123 1 emulator /sdk/emulator -avd test' '456 1 bash collect-emulator-diagnostics.sh'
exit "${FAKE_HOST_STATUS:-0}"
SHIM
  done
  chmod +x "$FAKE_BIN/timeout" "$FAKE_BIN/ps" "$FAKE_BIN/df" "$FAKE_BIN/free"
  export PATH="$FAKE_BIN"
  export AUTOMOBILE_KVM_DEVICE="$BATS_TEST_TMPDIR/kvm"
  export ANDROID_AVD_HOME="$BATS_TEST_TMPDIR/avd"
  export AUTOMOBILE_EMULATOR_TMP_DIR="$BATS_TEST_TMPDIR/tmp"
  : > "$AUTOMOBILE_KVM_DEVICE"
}

assert_host_files() {
  for file in host-processes.txt host-kvm.txt host-memory.txt host-disk.txt emulator-log-tail.txt; do
    [ -s "$DIAGNOSTICS/$file" ]
  done
  [[ "$(<"$DIAGNOSTICS/host-kvm.txt")" == *"readable=yes writable=yes"* ]]
}

@test "host diagnostics precede missing adb exit" {
  run bash "$SCRIPT" "$DIAGNOSTICS" "test failure"
  [ "$status" -eq 0 ]
  [ -f "$DIAGNOSTICS/adb-unavailable.txt" ]
  assert_host_files
  [[ "$(<"$DIAGNOSTICS/host-processes.txt")" != *"collect-emulator-diagnostics.sh"* ]]
  [[ "$(<"$DIAGNOSTICS/emulator-log-tail.txt")" == *"none found"* ]]
}

@test "host diagnostics precede no online device exit" {
  cat > "$FAKE_BIN/adb" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' 'List of devices attached' 'emulator-5554 offline'
SHIM
  chmod +x "$FAKE_BIN/adb"
  run bash "$SCRIPT" "$DIAGNOSTICS" "test failure"
  [ "$status" -eq 0 ]
  [ -f "$DIAGNOSTICS/no-online-device.txt" ]
  assert_host_files
}

@test "failed host and adb probes remain nonfatal" {
  printf '#!/usr/bin/env bash\nexit 1\n' > "$FAKE_BIN/adb"
  chmod +x "$FAKE_BIN/adb"
  run env FAKE_HOST_STATUS=1 bash "$SCRIPT" "$DIAGNOSTICS" "test failure"
  [ "$status" -eq 0 ]
  assert_host_files
}

@test "emulator logs are tailed from diagnostics AVD and temporary directories" {
  mkdir -p "$ANDROID_AVD_HOME/test.avd"
  for path in "$DIAGNOSTICS/launch-emulator.log" "$ANDROID_AVD_HOME/test.avd/emulator.log" "$AUTOMOBILE_EMULATOR_TMP_DIR/emu-log"; do
    for ((line=1; line<=250; line++)); do printf 'log-line-%s\n' "$line"; done > "$path"
  done
  run bash "$SCRIPT" "$DIAGNOSTICS" "test failure"
  [ "$status" -eq 0 ]
  log="$(<"$DIAGNOSTICS/emulator-log-tail.txt")"
  [[ "$log" == *"log-line-51"*"log-line-250"* ]]
  [[ "$log" != *$'log-line-1\n'* ]]
  [[ "$log" == *"$DIAGNOSTICS/launch-emulator.log"* ]]
  [[ "$log" == *"$ANDROID_AVD_HOME/test.avd/emulator.log"* ]]
  [[ "$log" == *"$AUTOMOBILE_EMULATOR_TMP_DIR/emu-log"* ]]
}
