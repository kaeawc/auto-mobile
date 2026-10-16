#!/usr/bin/env bash
# Shared clock/sleep seams; all live commands are bounded on the Linux runner.
set -euo pipefail
now() { "${NOW_CMD:-date}" +%s; }
run_wait() { "$@" <&0 & wait "$!"; }
pause() { run_wait "${SLEEP_CMD:-sleep}" "$1"; }
positive() { [[ "$2" =~ ^[1-9][0-9]{0,8}$ ]] || { echo "$1 must be a positive integer (at most 9 digits)" >&2; exit 2; }; }
# Allow the emulator wrapper to finish writing a core and its wait status.
await_exit() {
  local n
  for ((n=0;n<60;n++)); do
    [[ -f "$CYCLE_DIR/exit-time" ]] && return 0
    pause 1
  done
  [[ -f "$CYCLE_DIR/exit-time" ]]
}
finish_load() {
  if (( "$1" != 0 )); then
    # shellcheck disable=SC2310 # Missing exit evidence becomes a harness error after the bounded wait.
    await_exit || touch "$CYCLE_DIR/harness-error"
  elif [[ ! -f "$CYCLE_DIR/exit-time" ]]; then
    touch "$CYCLE_DIR/load-survived"
  fi
}
# Emit only positive crash evidence, never crashpad databases or empty files.
crash_evidence() {
  local dir=$1
  if [[ $(cat "$dir/exit-code" 2>/dev/null || true) == 139 ]]; then echo exit-code; fi
  if [[ -f "$dir/killed-by-SIGSEGV" ]]; then echo killed-by-SIGSEGV; fi
  if [[ -n $(find "$dir/cores" "$dir/dumps" -type f \( -name 'core.*' -o -name '*.dmp' \) -size +0c -print -quit 2>/dev/null || true) ]]; then echo core-or-minidump; fi
  if [[ -s "$dir/dmesg.log" ]] && grep -Ei '(emulator|qemu).*segfault|segfault.*(emulator|qemu)' "$dir/dmesg.log" >/dev/null; then echo dmesg.log; fi
  return 0
}
collect_crash_files() {
  local pattern=$1 destination=$2
  shift 2
  run_wait timeout -k 2 30 find "$@" -path "$CELL_DIR" -prune -o -type f -name "$pattern" -size +0c -newer "$CYCLE_DIR/start-time" -exec cp --backup=numbered {} "$CYCLE_DIR/$destination/" \;
}
acquired_device() {
  jq -er '(if .content? then (.content[] | select(.type == "text") | .text | fromjson) else . end)
    | [.runtime.deviceId, .runtime.session.sessionUuid]
    | select(all(.[]; type == "string" and length > 0)) | @tsv' "$1"
}
stop_private_daemon() {
  local pid
  if [[ -f "$AUTOMOBILE_DAEMON_PID_FILE_PATH" ]]; then
    pid=$(jq -er '.pid | select(type == "number" and . > 1 and floor == .)' "$AUTOMOBILE_DAEMON_PID_FILE_PATH") || return 1
    printf '%s TERM daemon\n' "$(now)" > "$CYCLE_DIR/daemon-kill-sent"
    "${KILL_CMD:-kill}" -TERM "$pid" 2>/dev/null || true
  fi
}
await_device_gone() {
  local n
  for ((n=0;n<30;n++)); do
    # shellcheck disable=SC2310 # Probe failure is returned to the caller for harness classification.
    run_wait timeout -k 1 5 adb devices > "$CYCLE_DIR/cleanup-devices.txt" || return 1
    if ! awk -v serial="$SERIAL" '$1==serial {found=1} END {exit !found}' "$CYCLE_DIR/cleanup-devices.txt"; then return 0; fi
    pause 1
  done
  return 1
}
operation() {
  local label=$1 rc=0
  shift
  printf '%s %s begin\n' "$(now)" "$label" >> "$CYCLE_DIR/ops.log"
  printf '%s\n' "$label" > "$CYCLE_DIR/op-in-flight"
  # shellcheck disable=SC2310 # Operation failure is data; record its status and continue the load.
  run_wait timeout -k 2 "${OP_TIMEOUT:-90}" "$@" >> "$CYCLE_DIR/operations.out" 2>&1 || rc=$?
  printf '%s %s end status=%s\n' "$(now)" "$label" "$rc" >> "$CYCLE_DIR/ops.log"
  if (( rc == 124 )); then printf '%s %s op-hang\n' "$(now)" "$label" >> "$CYCLE_DIR/ops.log"; touch "$CYCLE_DIR/op-hang"; fi
  printf 'idle\n' > "$CYCLE_DIR/op-in-flight"
  return 0
}
# Bounded heartbeat, independent of potentially blocked input/observe operations.
heartbeat() {
  local end=$(( $(now) + LOAD_SECONDS )) due rc timestamp delay
  due=$(now)
  timestamp=$(now)
  while (( timestamp < end )) && [[ ! -f "$CYCLE_DIR/exit-time" ]]; do
    timestamp=$(now); rc=0
    # shellcheck disable=SC2310 # Heartbeat failure is data; retain it without aborting evidence collection.
    run_wait timeout -k 1 4 adb -s "$SERIAL" get-state >> "$CYCLE_DIR/heartbeat.out" 2>&1 || rc=$?
    printf '%s heartbeat lateness=%s status=%s\n' "$timestamp" "$((timestamp-due))" "$rc" >> "$CYCLE_DIR/ops.log"
    if (( timestamp > due + 2 || rc != 0 )); then touch "$CYCLE_DIR/heartbeat-failed"; fi
    due=$((due+5))
    timestamp=$(now)
    delay=$((due-timestamp))
    if (( delay > 0 )); then pause "$delay"; fi
    timestamp=$(now)
  done
}
