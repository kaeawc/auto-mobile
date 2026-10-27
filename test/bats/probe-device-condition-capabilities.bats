#!/usr/bin/env bats
#
# Tests for scripts/local-dev/probe-device-condition-capabilities.sh (#14053).

SCRIPT="scripts/local-dev/probe-device-condition-capabilities.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  export MOCK_BIN
  export ADB_BIN="${MOCK_BIN}/adb"
  export INVOCATION_FILE="${MOCK_BIN}/adb-invocations"
  export MOCK_DEVICES="emulator-5554"
  export MOCK_MARKER=""
  export MOCK_SNAPSHOT_REPLY="OK"
  unset ADB_SERIAL OUT_FILE
  cat > "${ADB_BIN}" <<'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "devices" ]; then
  echo "List of devices attached"
  for serial in ${MOCK_DEVICES}; do printf '%s\tdevice\n' "${serial}"; done
  exit 0
fi
[ "$1" = "-s" ] && shift 2
printf '%s\n' "$*" >> "${INVOCATION_FILE}"
case "$*" in
  "shell getprop ro.secure") echo "1" ;;
  "shell getprop ro.debuggable") echo "1" ;;
  "shell getenforce") echo "Enforcing" ;;
  "shell am help") printf 'Activity manager commands:\n  crash [--user <USER_ID>] <PACKAGE|PID>\n' ;;
  "shell dumpsys battery -h")
    printf 'Battery service (battery) commands:\n  set [-f] [ac|usb|wireless|status|level] <value>\n  unplug [-f]\n  reset [-f]\n' ;;
  "shell cmd thermalservice help") printf '  inject-temperature TYPE STATUS NAME\n' ;;
  "shell settings get global always_finish_activities") echo "null" ;;
  "shell getprop ro.boot.verifiedbootstate") echo "orange" ;;
  "shell getprop ro.boot.flash.locked") echo "" ;;
  "shell uname -r") echo "6.6.30-android15-8-g0e1d|weird" ;;
  "shell magisk --path") echo "/system/bin/sh: magisk: inaccessible or not found"; exit 127 ;;
  "shell zcat /proc/config.gz") printf 'CONFIG_NET_SCH_NETEM=m\n# CONFIG_FAULT_INJECTION is not set\n' ;;
  "shell which tc") echo "/system/bin/sh: which: tc: not found"; exit 1 ;;
  "shell pm help") printf 'Package manager commands:\n  list packages\n' ;;
  "shell toybox") echo "cat chmod dd df" ;;
  "emu help power"|"emu help rotate") printf 'allows to change battery state\r\nOK\r\n' ;;
  "emu help "*) echo "KO: unknown command" ;;
  "shell echo automobile-14053 > "*) echo "automobile-14053" > "${MOCK_BIN}/marker" ;;
  "shell cat "*) cat "${MOCK_BIN}/marker" 2>/dev/null || echo "No such file or directory" ;;
  "emu avd snapshot save "*) echo "${MOCK_SNAPSHOT_REPLY}" ;;
  "shell id") echo "uid=0(root) gid=0(root)" ;;
  "shell su 0 id") echo "uid=0(root) gid=0(root)" ;;
esac
exit 0
SCRIPT
  chmod +x "${ADB_BIN}"
}

teardown() {
  rm -rf "${MOCK_BIN}"
}

row() {
  printf '%s\n' "$output" | grep -F "| $1 |"
}

@test "matrix marks commands available or missing from their output" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  row "SELinux mode" | grep -q "| yes | Enforcing |"
  row "am crash" | grep -q "| yes |"
  row "am send-trim-memory" | grep -q "| no |"
  row "dumpsys battery unplug" | grep -q "| yes |"
  row "thermal inject-temperature" | grep -q "| yes |"
  row "thermal override-status" | grep -q "| no |"
  row "ro.boot.flash.locked" | grep -q "| no | (empty) |"
  row "magisk" | grep -q "| no | /system/bin/sh: magisk: inaccessible or not found |"
  row "CONFIG_NET_SCH_NETEM" | grep -q "| yes | CONFIG_NET_SCH_NETEM=m |"
  row "CONFIG_FAULT_INJECTION" | grep -q "| no |"
  row "tc" | grep -q "| no |"
  row "toybox dd" | grep -q "| yes |"
  row "toybox fallocate" | grep -q "| no |"
}

@test "matrix probes console verbs and treats KO as unavailable" {
  run bash "$SCRIPT" matrix
  [ "$status" -eq 0 ]
  row "console \`power\`" | grep -q "| yes | allows to change battery state |"
  row "console \`finger\`" | grep -q "| no | KO: unknown command |"
}

@test "matrix escapes pipes in notes so the table stays well-formed" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  row "kernel release (GKI 2.0 for KernelSU)" | grep -qF '6.6.30-android15-8-g0e1d\|weird'
}

@test "matrix writes OUT_FILE when set" {
  OUT_FILE="${MOCK_BIN}/matrix.md" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -q "^# Device-condition capability matrix" "${MOCK_BIN}/matrix.md"
}

@test "requires ADB_SERIAL when more than one device is attached" {
  MOCK_DEVICES="emulator-5554 emulator-5556" run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"found 2"* ]]
  [[ "$output" == *"set ADB_SERIAL"* ]]
}

@test "persistence-prepare roots, remounts, writes the marker, then saves the snapshot" {
  run bash "$SCRIPT" persistence-prepare
  [ "$status" -eq 0 ]
  grep -qx "root" "$INVOCATION_FILE"
  grep -qx "remount" "$INVOCATION_FILE"
  [ "$(grep -n "remount" "$INVOCATION_FILE" | cut -d: -f1)" -lt \
    "$(grep -n "emu avd snapshot save root-fixture" "$INVOCATION_FILE" | cut -d: -f1)" ]
  [[ "$output" == *"-snapshot root-fixture -no-snapshot-save"* ]]
}

@test "persistence-prepare fails when the snapshot save is rejected" {
  MOCK_SNAPSHOT_REPLY="KO: snapshot failed" run bash "$SCRIPT" persistence-prepare
  [ "$status" -eq 1 ]
  [[ "$output" == *"Snapshot save was rejected"* ]]
}

@test "persistence-verify reports a surviving marker" {
  echo "automobile-14053" > "${MOCK_BIN}/marker"
  run bash "$SCRIPT" persistence-verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"RESULT: writable-system changes SURVIVED"* ]]
}

@test "persistence-verify reports a lost marker" {
  run bash "$SCRIPT" persistence-verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"RESULT: writable-system changes were LOST"* ]]
}

@test "rejects an unknown mode" {
  run bash "$SCRIPT" bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown mode 'bogus'"* ]]
}
