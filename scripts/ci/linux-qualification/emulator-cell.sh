#!/usr/bin/env bash
# Linux-only manual research harness. Wrapper mode is also used by AutoMobile's SDK.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ci/linux-qualification/lib.sh disable=SC1091
source "$here/lib.sh"
if [[ "${1:-}" == --emulator-wrapper ]]; then
  shift
  if [[ " $* " != *' -avd '* ]]; then exec "$REAL_EMULATOR" "$@"; fi
  ulimit -c unlimited || true
  jq -n --args '$ARGS.positional' -- "$@" > "$CYCLE_DIR/argv.json"
  now > "$CYCLE_DIR/start-time"
  # Regular files remain available even if the wrapper is terminated mid-load.
  "$REAL_EMULATOR" "$@" > "$CYCLE_DIR/stdout.pending" 2> "$CYCLE_DIR/stderr.pending" &
  child=$!
  printf '%s\n' "$$" > "$CYCLE_DIR/wrapper.pid"
  printf '%s\n' "$child" > "$CYCLE_DIR/emulator.pid"
  # Daemon-directed TERM/INT/HUP must be distinguished from unsolicited SEGV.
  trap 'printf "%s TERM\n" "$(now)" > "$CYCLE_DIR/kill-sent"; kill -TERM "$child" 2>/dev/null || true' TERM
  trap 'printf "%s INT\n" "$(now)" > "$CYCLE_DIR/kill-sent"; kill -INT "$child" 2>/dev/null || true' INT
  trap 'printf "%s HUP\n" "$(now)" > "$CYCLE_DIR/kill-sent"; kill -HUP "$child" 2>/dev/null || true' HUP
  rc=0
  wait "$child" || rc=$?
  if kill -0 "$child" 2>/dev/null; then wait "$child" || rc=$?; fi
  printf '%s\n' "$rc" > "$CYCLE_DIR/exit-code"
  now > "$CYCLE_DIR/exit-time"
  printf 'wait status=%s\n' "$rc" > "$CYCLE_DIR/wait-status.txt"
  tee "$CYCLE_DIR/emulator.stdout" < "$CYCLE_DIR/stdout.pending"
  tee "$CYCLE_DIR/emulator.stderr" < "$CYCLE_DIR/stderr.pending" >&2
  rm "$CYCLE_DIR/stdout.pending" "$CYCLE_DIR/stderr.pending"
  exit "$rc"
fi
# Bound setup as well as cycles, leaving ten minutes for artifact upload.
positive CELL_BUDGET_SECONDS "${CELL_BUDGET_SECONDS:-4800}"
if [[ "${1:-}" != --budgeted ]]; then
  timestamp=$(now)
  export CELL_STARTED_AT="${CELL_STARTED_AT:-$timestamp}"
  remaining=$(( ${CELL_BUDGET_SECONDS:-4800} - timestamp + CELL_STARTED_AT ))
  (( remaining > 0 )) || remaining=1
  exec timeout -k 30 "$remaining" bash "$0" --budgeted
fi
: "${RUNNER_TEMP:?}" "${CELL_DIR:?}" "${GPU:?}" "${GPU_ARGS:?}" "${WORKLOAD:?}"
mkdir -p "$CELL_DIR"
CELL_DIR="$(cd "$CELL_DIR" && pwd)"
export CELL_DIR LOAD_SECONDS="${LOAD_SECONDS:-300}" CYCLES="${CYCLES:-1}"
positive LOAD_SECONDS "$LOAD_SECONDS"; positive CYCLES "$CYCLES"
positive CELL_BUDGET_SECONDS "${CELL_BUDGET_SECONDS:-4800}"
positive BOOT_SECONDS "${BOOT_SECONDS:-600}"
(( ${BOOT_SECONDS:-600} <= 600 )) || { echo "BOOT_SECONDS must be <= 600" >&2; exit 2; }
deadline=$(( CELL_STARTED_AT + ${CELL_BUDGET_SECONDS:-4800} ))
boot_seconds=${BOOT_SECONDS:-600}
case "$GPU" in swangle|swiftshader_indirect|host|angle_indirect) ;; *) exit 2;; esac
case "$WORKLOAD" in automobile|raw-adb-control|heartbeat-only) ;; *) exit 2;; esac
jq -e 'type=="array" and all(.[];type=="string" and length>0)' <<< "$GPU_ARGS" >/dev/null
export REAL_EMULATOR="$ANDROID_HOME/emulator/emulator"
run_wait "$REAL_EMULATOR" -version > "$CELL_DIR/emulator-version.txt" 2>&1
version=$(cat "$CELL_DIR/emulator-version.txt")
private=$(mktemp -d "$RUNNER_TEMP/lq.XXXXXX")
export ANDROID_AVD_HOME="$private/avd" ANDROID_USER_HOME="$private/android"
mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME" "$CELL_DIR/cores"
jq -n --arg cell "$GPU-$WORKLOAD" --arg gpu "$GPU" --arg workload "$WORKLOAD" \
  --arg version "$version" --argjson cycles "$CYCLES" --argjson args "$GPU_ARGS" \
  '{cell:$cell,gpu:$gpu,workload:$workload,cycles_planned:$cycles,cycles_completed:0,
    emulator_version:$version,argv:$args,heartbeat_failed:false}' > "$CELL_DIR/environment.json"
# An ERR produces useful evidence and fails only the harness, never a measured crash.
cell_error() {
  trap - ERR TERM INT
  local evidence_dir=${CYCLE_DIR:-$CELL_DIR}
  # shellcheck disable=SC2310 # Best-effort wait for exit evidence before classifying the error.
  if [[ ${1:-} == ERR && -n ${CYCLE_DIR:-} && ! -f "$CYCLE_DIR/exit-time" ]]; then await_exit || true; fi
  touch "$evidence_dir/harness-error"
  bash "$here/classify-exit.sh" "$evidence_dir"
  if [[ "$evidence_dir" != "$CELL_DIR" ]]; then cp "$evidence_dir/result.json" "$CELL_DIR/result.json"; fi
  exit 1
}
trap 'cell_error ERR' ERR
trap 'cell_error TERM' TERM INT
{
  printf 'Source SHA: '; git rev-parse HEAD
  printf 'AutoMobile package: '; jq -r .version package.json
  printf 'Emulator: %s\nSystem image: system-images;android-35;google_apis;x86_64\n' "$version"
  uname -a; lscpu; free -h
  printf 'KVM writable: '; if test -w /dev/kvm; then echo yes; else echo no; fi
  printf 'GPU driver: '; ls -l /dev/dri 2>/dev/null || echo none
  lspci -nnk 2>/dev/null || true
  printf 'Snapshot policy: -no-snapshot-load -no-snapshot-save\n'
} > "$CELL_DIR/environment.txt"
test -w "${KVM_DEVICE:-/dev/kvm}"
if [[ "$GPU" == host && ! -d /dev/dri ]]; then
  touch "$CELL_DIR/host-unavailable"
  printf 'Host GPU unavailable: no /dev/dri device\n' > "$CELL_DIR/not-exercised.txt"
  bash "$here/classify-exit.sh" "$CELL_DIR"
  exit 0
fi
# License acceptance can give yes SIGPIPE; sdkmanager's status is authoritative.
# Keep the required wait at top level so a failure still runs the cell's ERR trap.
# shellcheck disable=SC2016 # PIPESTATUS belongs to the child shell.
timeout -k 5 180 bash -c 'yes | sdkmanager --licenses; exit ${PIPESTATUS[1]}' > "$CELL_DIR/licenses.log" 2>&1 <&0 &
wait "$!"
run_wait timeout -k 5 600 sdkmanager 'system-images;android-35;google_apis;x86_64' > "$CELL_DIR/sdk.log" 2>&1
profile=medium_phone
run_wait avdmanager list device > "$CELL_DIR/hardware-profiles.txt"
if ! grep -q '"medium_phone"' "$CELL_DIR/hardware-profiles.txt"; then profile=pixel_6; fi
printf 'Hardware profile: %s (fallback only when medium_phone id absent)\n' "$profile" >> "$CELL_DIR/environment.txt"
run_wait avdmanager create avd --force -n medium_phone -k 'system-images;android-35;google_apis;x86_64' -d "$profile" > "$CELL_DIR/avd-create.log" 2>&1 <<< no
cp "$ANDROID_AVD_HOME/medium_phone.avd/config.ini" "$CELL_DIR/config.ini"
cat "$CELL_DIR/config.ini" >> "$CELL_DIR/environment.txt"
# Shadow just emulator/emulator; all other SDK contents stay the installed version.
mkdir -p "$private/sdk/emulator"
for item in "$ANDROID_HOME"/*; do
  [[ ${item##*/} == emulator ]] || ln -s "$item" "$private/sdk/${item##*/}"
done
for item in "$ANDROID_HOME/emulator"/*; do
  [[ ${item##*/} == emulator ]] || ln -s "$item" "$private/sdk/emulator/${item##*/}"
done
printf '#!/usr/bin/env bash\nexec bash %q --emulator-wrapper "$@"\n' "$here/emulator-cell.sh" > "$private/sdk/emulator/emulator"
chmod +x "$private/sdk/emulator/emulator"
export ANDROID_HOME="$private/sdk" ANDROID_SDK_ROOT="$private/sdk"
export AUTOMOBILE_EMULATOR_ARGS
AUTOMOBILE_EMULATOR_ARGS=$(jq -c '.+["-no-snapshot-load","-no-snapshot-save","-no-boot-anim","-camera-back","none","-verbose"]' <<< "$GPU_ARGS")
export AUTOMOBILE_EMULATOR_HEADLESS=true AUTOMOBILE_EMULATOR_AUDIO=false AUTOMOBILE_APPEARANCE_SYNC=0
# shellcheck disable=SC2024,SC2310 # User-owned evidence; debugger installation is best effort.
run_wait timeout -k 5 60 sudo -n apt-get install -y gdb > "$CELL_DIR/gdb-install.log" 2>&1 || true
completed=0
for ((cycle=1; cycle<=CYCLES; cycle++)); do
  # Reserve boot, load, bounded operations, shutdown and evidence collection.
  timestamp=$(now)
  if (( deadline - timestamp < boot_seconds + LOAD_SECONDS + 600 )); then break; fi
  export CYCLE_DIR="$CELL_DIR/cycle-$cycle"
  mkdir -p "$CYCLE_DIR/cores" "$CYCLE_DIR/dumps"
  cp "$CELL_DIR/environment.json" "$CYCLE_DIR/environment.json"
  export AUTOMOBILE_DATA_DIR="$private/c$cycle/data" AUTOMOBILE_LOG_DIR="$CYCLE_DIR/daemon-logs"
  export AUTOMOBILE_DB_PATH="$private/c$cycle/db/auto-mobile.db"
  export AUTOMOBILE_DB_DIR="$private/c$cycle/db" AUTOMOBILE_COORDINATION_DIR="$private/c$cycle/coord"
  export AUTOMOBILE_ADB_SERVER_COORDINATION_DIR="$private/c$cycle/adb-coord"
  export AUTOMOBILE_AUX_SOCKET_DIR="$private/c$cycle/sockets" AUTOMOBILE_HARNESS_PRIVATE_DAEMON=1
  export AUTOMOBILE_DAEMON_SOCKET_PATH="$private/c$cycle/d.sock" AUTOMOBILE_DAEMON_PID_FILE_PATH="$private/c$cycle/d.pid"
  export AUTOMOBILE_DAEMON_LOCK_FILE_PATH="$private/c$cycle/d.lock" AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH="$private/c$cycle/w.sock"
  mkdir -p "$AUTOMOBILE_AUX_SOCKET_DIR"
  ulimit -c unlimited || true
  # shellcheck disable=SC2024 # Destination is deliberately user-owned evidence.
  sudo -n sysctl -w "kernel.core_pattern=$CYCLE_DIR/cores/core.%e.%p" > "$CYCLE_DIR/core-pattern.log" 2>&1 || true
  export SERIAL=emulator-5554
  now > "$CYCLE_DIR/start-time"
  launcher=''
  boot_deadline=$(( $(now) + boot_seconds ))
  export SESSION_UUID=''
  acquisition_rc=0
  if [[ "$WORKLOAD" == automobile ]]; then
    timeout -k 5 "$boot_seconds" auto-mobile --cli getAndroid --avdName medium_phone --boot-timeout-ms "$((boot_seconds * 1000))" > "$CYCLE_DIR/start.json" 2> "$CYCLE_DIR/start.stderr" &
    launcher=$!
    wait "$launcher" || acquisition_rc=$?
    if (( acquisition_rc == 0 )); then
      acquisition=$(acquired_device "$CYCLE_DIR/start.json")
      IFS=$'\t' read -r SERIAL SESSION_UUID <<< "$acquisition"
    fi
  else
    mapfile -t gpu_argv < <(jq -r '.[]' <<< "$AUTOMOBILE_EMULATOR_ARGS")
    bash "$here/emulator-cell.sh" --emulator-wrapper -avd medium_phone -no-window -no-audio "${gpu_argv[@]}" &
  fi
  ready=false
  timestamp=$(now)
  while (( timestamp < boot_deadline && acquisition_rc == 0 )) && [[ ! -f "$CYCLE_DIR/exit-time" ]]; do
    # shellcheck disable=SC2310 # Boot probe failure is data; keep polling until the deadline.
    run_wait timeout 5 adb -s "$SERIAL" shell getprop sys.boot_completed > "$CYCLE_DIR/boot-property.txt" 2>/dev/null || true
    if [[ "$(tr -d '\r' < "$CYCLE_DIR/boot-property.txt")" == 1 ]]; then ready=true; break; fi
    pause 5
    timestamp=$(now)
  done
  # shellcheck disable=SC2310 # Best-effort wait for exit evidence after unsuccessful boot.
  if [[ "$ready" == false && ! -f "$CYCLE_DIR/exit-time" ]]; then await_exit || true; fi
  if [[ "$GPU" == host && "$ready" == false ]]; then
    # shellcheck disable=SC2310 # Missing crash evidence is data for host availability classification.
    if [[ -z $(crash_evidence "$CYCLE_DIR") ]]; then touch "$CYCLE_DIR/host-unavailable"; fi
  fi
  if [[ "$ready" == false && "$GPU" != host && ! -f "$CYCLE_DIR/exit-time" ]]; then touch "$CYCLE_DIR/harness-error"; fi
  load_rc=0
  logcat_pid=
  if [[ "$ready" == true && ! -f "$CYCLE_DIR/exit-time" ]]; then
    touch "$CYCLE_DIR/ready"
    adb -s "$SERIAL" wait-for-device logcat -b all > "$CYCLE_DIR/logcat-all.log" 2>&1 &
    logcat_pid=$!
    if [[ "$WORKLOAD" != heartbeat-only ]]; then
      # Both loads reset Settings before each iteration. H leaves the booted UI idle.
      run_wait timeout -k 2 15 adb -s "$SERIAL" shell am start -a android.settings.SETTINGS > "$CYCLE_DIR/target.log" 2>&1
      heartbeat & heartbeat_pid=$!
      if [[ "$WORKLOAD" == automobile ]]; then script=workload-automobile.sh; else script=workload-raw-adb.sh; fi
      # shellcheck disable=SC2310 # Load failure is classified by finish_load after collecting exit evidence.
      run_wait bash "$here/$script" || load_rc=$?
      wait "$heartbeat_pid" || true
    else
      # shellcheck disable=SC2310 # Load failure is classified by finish_load after collecting exit evidence.
      run_wait bash "$here/workload-heartbeat.sh" || load_rc=$?
    fi
    finish_load "$load_rc"
    if [[ -f "$CYCLE_DIR/load-survived" ]]; then completed=$((completed+1)); fi
    # shellcheck disable=SC2310 # Best-effort evidence collection must not abort the cell.
    run_wait timeout -k 2 10 adb -s "$SERIAL" logcat -b crash,main -d > "$CYCLE_DIR/logcat-crash-main.log" 2>&1 || true
  fi
  # Do not overwrite a spontaneous exit with a later cleanup marker.
  if [[ ! -f "$CYCLE_DIR/exit-time" ]]; then
    now > "$CYCLE_DIR/shutdown-intent"
    if [[ "$WORKLOAD" == automobile && -n "${SESSION_UUID:-}" ]]; then
      device=$(jq -nc --arg id "$SERIAL" '{name:"medium_phone",deviceId:$id,platform:"android"}')
      # shellcheck disable=SC2310 # Best-effort shutdown; bounded signal fallback follows.
      run_wait timeout -k 5 30 auto-mobile --cli --session-uuid "$SESSION_UUID" killDevice --device "$device" > "$CYCLE_DIR/shutdown.log" 2>&1 || true
    else
      # shellcheck disable=SC2310 # Best-effort shutdown; bounded signal fallback follows.
      run_wait timeout -k 5 15 adb -s "$SERIAL" emu kill > "$CYCLE_DIR/shutdown.log" 2>&1 || true
    fi
    for ((n=0;n<10;n++)); do [[ -f "$CYCLE_DIR/exit-time" ]] && break; pause 1; done
    if [[ ! -f "$CYCLE_DIR/exit-time" && -f "$CYCLE_DIR/emulator.pid" ]]; then
      printf '%s TERM\n' "$(now)" > "$CYCLE_DIR/kill-sent"
      kill -TERM "$(cat "$CYCLE_DIR/emulator.pid")" 2>/dev/null || true
      pause 2
      if kill -0 "$(cat "$CYCLE_DIR/emulator.pid")" 2>/dev/null; then
        printf '%s KILL\n' "$(now)" > "$CYCLE_DIR/kill-sent"
        kill -KILL "$(cat "$CYCLE_DIR/emulator.pid")" 2>/dev/null || true
        pause 1
      fi
    fi
  fi
  # Best-effort evidence collection cannot fail the cell.
  printf '%s TERM logcat\n' "$(now)" > "$CYCLE_DIR/logcat-kill-sent"
  if [[ -n "$logcat_pid" ]]; then kill "$logcat_pid" 2>/dev/null || true; fi
  # shellcheck disable=SC2310 # Best-effort evidence collection must not abort the cell.
  run_wait timeout -k 2 15 sudo -n dmesg --since "$(date -d "@$(cat "$CYCLE_DIR/start-time")" +'%F %T')" > "$CYCLE_DIR/dmesg-all.log" 2>&1 || true
  grep -iE 'segfault|emulator|oom' "$CYCLE_DIR/dmesg-all.log" > "$CYCLE_DIR/dmesg.log" || true
  # shellcheck disable=SC2310 # Best-effort evidence collection must not abort the cell.
  collect_crash_files '*.dmp' dumps /tmp "$ANDROID_USER_HOME" "$HOME/.android" 2> "$CYCLE_DIR/find.log" || true
  # shellcheck disable=SC2310 # Best-effort evidence collection must not abort the cell.
  collect_crash_files 'core.*' cores /tmp "$ANDROID_USER_HOME" "$HOME/.android" 2>> "$CYCLE_DIR/find.log" || true
  for core in "$CYCLE_DIR"/cores/*; do
    [[ -f "$core" && -s "$core" ]] || continue
    debug_binary="$REAL_EMULATOR"
    if [[ ${core##*/} == *qemu* ]]; then debug_binary="${REAL_EMULATOR%/*}/qemu/linux-x86_64/qemu-system-x86_64"; fi
    # shellcheck disable=SC2310 # Best-effort evidence collection must not abort the cell.
    run_wait timeout -k 2 30 gdb -batch -ex 'thread apply all bt' "$debug_binary" "$core" >> "$CYCLE_DIR/backtrace.log" 2>&1 || true
  done
  if [[ ! -f "$CYCLE_DIR/backtrace.log" ]]; then printf 'Backtrace skipped: no ELF core; minidumps retained if found\n' > "$CYCLE_DIR/backtrace.log"; fi
  grep '^#' "$CYCLE_DIR/backtrace.log" 2>/dev/null | head -5 > "$CYCLE_DIR/top-frames.txt" || true
  if [[ -f "$CYCLE_DIR/argv.json" ]]; then
    jq --slurpfile argv "$CYCLE_DIR/argv.json" ' .argv=$argv[0]' "$CYCLE_DIR/environment.json" > "$CYCLE_DIR/env.tmp"
    mv "$CYCLE_DIR/env.tmp" "$CYCLE_DIR/environment.json"
    cat "$CYCLE_DIR/argv.json" >> "$CELL_DIR/environment.txt"
  fi
  if [[ -f "$CYCLE_DIR/heartbeat-failed" ]]; then
    jq '.heartbeat_failed=true' "$CYCLE_DIR/environment.json" > "$CYCLE_DIR/env.tmp"
    mv "$CYCLE_DIR/env.tmp" "$CYCLE_DIR/environment.json"
  fi
  jq --argjson completed "$completed" '.cycles_completed=$completed' "$CYCLE_DIR/environment.json" > "$CYCLE_DIR/env.tmp"
  mv "$CYCLE_DIR/env.tmp" "$CYCLE_DIR/environment.json"
  bash "$here/classify-exit.sh" "$CYCLE_DIR"
  stop_private_daemon
  # shellcheck disable=SC2310 # Cleanup probe failure is classified as a harness error below.
  if ! await_device_gone; then
    touch "$CYCLE_DIR/harness-error"
    bash "$here/classify-exit.sh" "$CYCLE_DIR"
    break
  fi
  outcome=$(jq -r .outcome "$CYCLE_DIR/result.json")
  [[ "$outcome" == shutdown || "$outcome" == survived ]] || break
done
shopt -s nullglob
results=("$CELL_DIR"/cycle-*/result.json)
if ((${#results[@]})); then
  jq -s --argjson completed "$completed" --argjson planned "$CYCLES" \
    'sort_by(if .outcome=="crash" then 0 elif .outcome=="harness-error" then 1 elif .outcome=="shutdown" or .outcome=="survived" then 3 else 2 end) | .[0] + {cycles_completed:$completed,cycles_planned:$planned}' "${results[@]}" > "$CELL_DIR/result.json"
else
  printf 'Budget insufficient for boot + load; no cycles started\n' > "$CELL_DIR/not-exercised.txt"
  touch "$CELL_DIR/host-unavailable"
  bash "$here/classify-exit.sh" "$CELL_DIR"
fi
if find "$CELL_DIR" -name heartbeat-failed | grep -q .; then
  jq '.heartbeat_failed=true' "$CELL_DIR/result.json" > "$CELL_DIR/result.tmp"; mv "$CELL_DIR/result.tmp" "$CELL_DIR/result.json"
fi
if [[ $(jq -r .outcome "$CELL_DIR/result.json") == crash ]]; then echo '::warning::Real emulator crash captured'; fi
[[ $(jq -r .outcome "$CELL_DIR/result.json") != harness-error ]]
