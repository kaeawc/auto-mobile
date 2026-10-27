#!/usr/bin/env bash
# Probe an Android emulator for the commands the device-condition fixtures rely
# on (#14053), and check whether -writable-system changes survive a snapshot.
#
# Usage:
#   probe-device-condition-capabilities.sh [matrix]       # capability matrix (Markdown)
#   probe-device-condition-capabilities.sh persistence-prepare
#   probe-device-condition-capabilities.sh persistence-verify
#
# Environment:
#   ADB_SERIAL     Target device. Optional when exactly one device is attached.
#   SNAPSHOT_NAME  Snapshot used by the persistence check (default: root-fixture).
#   MARKER_PATH    /system file pushed by the persistence check.
#   OUT_FILE       Also write the matrix to this file.
#
# Persistence check (needs an emulator started with -writable-system):
#   1. persistence-prepare: adb root + remount, write a marker under /system,
#      then `avd snapshot save $SNAPSHOT_NAME`.
#   2. Stop the emulator and cold-start it from the snapshot without saving:
#        emulator -avd <avd> -writable-system -snapshot root-fixture -no-snapshot-save
#   3. persistence-verify: reports whether the marker, `id`, and `su` survived.

set -euo pipefail

SNAPSHOT_NAME="${SNAPSHOT_NAME:-root-fixture}"
MARKER_PATH="${MARKER_PATH:-/system/etc/automobile-writable-system-marker}"
MARKER_CONTENT="automobile-14053"
OUT_FILE="${OUT_FILE:-}"
ADB_BIN="${ADB_BIN:-adb}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v "${ADB_BIN}" >/dev/null 2>&1 || fail "adb not found on PATH (or set ADB_BIN)."

resolve_serial() {
  if [[ -n "${ADB_SERIAL:-}" ]]; then
    printf '%s\n' "${ADB_SERIAL}"
    return 0
  fi
  local serials
  serials="$("${ADB_BIN}" devices | awk 'NR > 1 && $2 == "device" {print $1}')"
  local count
  count="$(grep -c . <<<"${serials}" || true)"
  [[ "${count}" -eq 1 ]] || fail "Expected exactly one attached device (found ${count}); set ADB_SERIAL."
  printf '%s\n' "${serials}"
}

SERIAL="$(resolve_serial)"

# Probe output is evidence, not a verdict: a failing command is recorded, never fatal.
adb_shell() {
  "${ADB_BIN}" -s "${SERIAL}" shell "$1" 2>&1 | tr -d '\r' || true
}

adb_emu() {
  "${ADB_BIN}" -s "${SERIAL}" emu "$@" 2>&1 | tr -d '\r' || true
}

# First non-empty line, with Markdown table pipes escaped.
first_line() {
  awk 'NF {print; exit}' | cut -c1-120 | sed 's/|/\\|/g'
}

MATRIX_ROWS=()

# record <capability> <command> <yes|no> <note>
record() {
  MATRIX_ROWS+=("| $1 | \`$2\` | $3 | $4 |")
}

# probe_match <capability> <shell-command> <extended-regex>
# Available when the command's output matches the regex.
probe_match() {
  local output
  output="$(adb_shell "$2")"
  if grep -Eq -- "$3" <<<"${output}"; then
    record "$1" "$2" yes "$(grep -E -- "$3" <<<"${output}" | first_line)"
  else
    record "$1" "$2" no "$(first_line <<<"${output}")"
  fi
}

# probe_value <capability> <shell-command>
# Available when the command prints a non-empty value; the value is the note.
probe_value() {
  local value
  value="$(adb_shell "$2" | first_line)"
  if [[ -n "${value}" ]]; then
    record "$1" "$2" yes "${value}"
  else
    record "$1" "$2" no "(empty)"
  fi
}

# probe_console <verb>: `help <verb>` answers KO for verbs this emulator lacks.
probe_console() {
  local output
  output="$(adb_emu help "$1")"
  if [[ -z "${output}" ]] || grep -q '^KO' <<<"${output}"; then
    record "console \`$1\`" "emu help $1" no "$(first_line <<<"${output}")"
  else
    record "console \`$1\`" "emu help $1" yes "$(first_line <<<"${output}")"
  fi
}

run_matrix() {
  probe_value "ro.secure" "getprop ro.secure"
  probe_value "ro.debuggable" "getprop ro.debuggable"
  probe_match "SELinux mode" "getenforce" "^(Enforcing|Permissive|Disabled)$"
  probe_match "am send-trim-memory" "am help" "send-trim-memory"
  probe_match "am crash" "am help" "^[[:space:]]*crash[[:space:]]"
  probe_match "dumpsys battery set" "dumpsys battery -h" "^[[:space:]]*set[[:space:]]"
  probe_match "dumpsys battery unplug" "dumpsys battery -h" "^[[:space:]]*unplug"
  probe_match "dumpsys battery reset" "dumpsys battery -h" "^[[:space:]]*reset"
  probe_match "thermal inject-temperature" "cmd thermalservice help" "inject-temperature"
  probe_match "thermal override-status" "cmd thermalservice help" "override-status"
  probe_value "always_finish_activities" "settings get global always_finish_activities"
  probe_value "ro.boot.verifiedbootstate" "getprop ro.boot.verifiedbootstate"
  probe_value "ro.boot.flash.locked" "getprop ro.boot.flash.locked"
  probe_value "kernel release (GKI 2.0 for KernelSU)" "uname -r"
  # A bare absolute path; "/system/bin/sh: magisk: not found" also starts with "/".
  probe_match "magisk" "magisk --path" "^/[^:[:space:]]*$"
  probe_match "CONFIG_FAULT_INJECTION" "zcat /proc/config.gz" "^CONFIG_FAULT_INJECTION=y"
  probe_match "CONFIG_NET_SCH_NETEM" "zcat /proc/config.gz" "^CONFIG_NET_SCH_NETEM=(y|m)"
  probe_match "debugfs fail_* knobs" "ls -d /sys/kernel/debug/fail_*" "^/sys/kernel/debug/fail_"
  probe_match "tc" "which tc" "^/[^:[:space:]]*$"
  probe_match "pm help" "pm help" "^[[:space:]]*(list|install|clear)[[:space:]]"
  probe_match "toybox fallocate" "toybox" "(^|[[:space:]])fallocate([[:space:]]|$)"
  probe_match "toybox dd" "toybox" "(^|[[:space:]])dd([[:space:]]|$)"
  local verb
  for verb in rotate power sensor network finger avd; do
    probe_console "${verb}"
  done

  {
    printf '# Device-condition capability matrix\n\n'
    printf -- "- Serial: \`%s\`\n" "${SERIAL}"
    printf -- "- Fingerprint: \`%s\`\n" "$(adb_shell "getprop ro.build.fingerprint" | first_line)"
    printf -- "- API level: \`%s\`\n\n" "$(adb_shell "getprop ro.build.version.sdk" | first_line)"
    printf '| Capability | Command | Available | Note |\n'
    printf '| --- | --- | --- | --- |\n'
    printf '%s\n' ${MATRIX_ROWS[@]+"${MATRIX_ROWS[@]}"}
  } | if [[ -n "${OUT_FILE}" ]]; then tee "${OUT_FILE}"; else cat; fi
}

persistence_prepare() {
  printf '==> adb root\n'
  "${ADB_BIN}" -s "${SERIAL}" root
  "${ADB_BIN}" -s "${SERIAL}" wait-for-device
  printf '==> adb remount\n'
  "${ADB_BIN}" -s "${SERIAL}" remount
  printf '==> write marker %s\n' "${MARKER_PATH}"
  "${ADB_BIN}" -s "${SERIAL}" shell "echo ${MARKER_CONTENT} > ${MARKER_PATH}"
  local readback
  readback="$(adb_shell "cat ${MARKER_PATH}")"
  [[ "${readback}" == "${MARKER_CONTENT}" ]] ||
    fail "Marker write did not read back (got '${readback}'). Was the emulator started with -writable-system?"
  printf '==> avd snapshot save %s\n' "${SNAPSHOT_NAME}"
  local save_output
  save_output="$(adb_emu avd snapshot save "${SNAPSHOT_NAME}")"
  printf '%s\n' "${save_output}"
  if grep -q '^KO' <<<"${save_output}"; then
    fail "Snapshot save was rejected."
  fi
  printf '\nNext: stop the emulator, then cold-start it from the snapshot without saving:\n'
  printf '  emulator -avd <avd> -writable-system -snapshot %s -no-snapshot-save\n' "${SNAPSHOT_NAME}"
  printf 'and run: %s persistence-verify\n' "$0"
}

persistence_verify() {
  local marker id_output su_output
  marker="$(adb_shell "cat ${MARKER_PATH}")"
  id_output="$(adb_shell "id" | first_line)"
  su_output="$(adb_shell "su 0 id" | first_line)"
  printf '| Check | Command | Result |\n'
  printf '| --- | --- | --- |\n'
  printf "| marker | \`cat %s\` | %s |\n" "${MARKER_PATH}" "$(first_line <<<"${marker}")"
  printf "| shell identity | \`id\` | %s |\n" "${id_output}"
  printf "| su | \`su 0 id\` | %s |\n" "${su_output}"
  if [[ "${marker}" == "${MARKER_CONTENT}" ]]; then
    printf '\nRESULT: writable-system changes SURVIVED the snapshot reload.\n'
  else
    printf '\nRESULT: writable-system changes were LOST on the snapshot reload.\n'
  fi
}

case "${1:-matrix}" in
  matrix) run_matrix ;;
  persistence-prepare) persistence_prepare ;;
  persistence-verify) persistence_verify ;;
  *) fail "Unknown mode '${1}'. Expected matrix, persistence-prepare, or persistence-verify." ;;
esac
