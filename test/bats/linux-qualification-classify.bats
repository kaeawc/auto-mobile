#!/usr/bin/env bats
setup() {
  base="$BATS_TEST_TMPDIR/evidence"
  mkdir -p "$base/cell"
  dir="$base/cell"
  script="$BATS_TEST_DIRNAME/../../scripts/ci/linux-qualification"
  jq -n '{cell:"swangle-automobile",gpu:"swangle",workload:"automobile",cycles_planned:1,cycles_completed:1,emulator_version:"test",argv:[]}' > "$dir/environment.json"
  printf '100\n' > "$dir/start-time"
}
classify() { bash "$script/classify-exit.sh" "$dir"; }
exited() { printf '200\n' > "$dir/exit-time"; printf '%s\n' "$1" > "$dir/exit-code"; }
@test "survived requires a whole load window" {
  run classify; [ "$output" = unknown-exit ]
  touch "$dir/load-survived"
  run classify; [ "$status" -eq 0 ]; [ "$output" = survived ]
  jq -e '.cell=="swangle-automobile" and .outcome=="survived"' "$dir/result.json"
}
@test "unmarked SIGSEGV is crash with duration op and frames" {
  exited 139; echo observe > "$dir/op-in-flight"; echo '#0 renderer' > "$dir/top-frames.txt"
  run classify; [ "$output" = crash ]
  jq -e '.time_to_exit_seconds==100 and .op_in_flight=="observe" and .top_frames==["#0 renderer"]' "$dir/result.json"
}
@test "dump core signal marker and emulator dmesg each supply crash evidence" {
  exited 1
  for evidence in dumps cores killed-by-SIGSEGV dmesg.log; do
    case "$evidence" in
      dumps) mkdir -p "$dir/dumps"; echo dump > "$dir/dumps/crash.dmp";;
      cores) mkdir -p "$dir/cores"; echo core > "$dir/cores/core.qemu.42";;
      dmesg.log) echo 'qemu-system-x86: segfault at 0' > "$dir/$evidence";;
      *) touch "$dir/$evidence";;
    esac
    run classify; [ "$output" = crash ]; rm -rf "$dir/$evidence"
  done
}
@test "shutdown intent only explains exits after it" {
  exited 139; echo 201 > "$dir/shutdown-intent"
  run classify; [ "$output" = crash ]
  echo 199 > "$dir/shutdown-intent"
  run classify; [ "$output" = crash ]
  jq -e '.evidence|index("during-shutdown")!=null' "$dir/result.json"
  exited 0
  run classify; [ "$output" = shutdown ]
}
@test "recorded signal is kill only when sent before exit" {
  exited 139; echo '201 TERM' > "$dir/kill-sent"
  run classify; [ "$output" = crash ]
  echo '199 TERM' > "$dir/kill-sent"
  run classify; [ "$output" = kill ]
}
@test "non SEGV exit is unknown never an inferred injected kill" {
  exited 143; echo 'out of memory' > "$dir/dmesg.log"
  run classify; [ "$output" = unknown-exit ]
}
@test "host unsupported boot and harness errors are distinct" {
  touch "$dir/host-unavailable"; exited 1
  run classify; [ "$output" = unexercised ]
  touch "$dir/harness-error"
  run classify; [ "$output" = harness-error ]
}
@test "summary separates passes failures unexercised and rejects late heartbeats" {
  touch "$dir/load-survived"; classify
  mkdir -p "$base/crash" "$base/host" "$base/late"
  jq '.cell="angle_indirect-automobile"|.outcome="crash"' "$dir/result.json" > "$base/crash/result.json"
  jq '.cell="host-automobile"|.outcome="unexercised"' "$dir/result.json" > "$base/host/result.json"
  jq '.cell="swangle-heartbeat-only"|.heartbeat_failed=true' "$dir/result.json" > "$base/late/result.json"
  bash "$script/summarize.sh" "$base"
  jq -e '.passes==["swangle-automobile"] and (.failures|index("angle_indirect-automobile"))!=null and (.failures|index("swangle-heartbeat-only"))!=null and (.unexercised|index("host-automobile"))!=null and (.no_result|length)==8 and (.classified_exits|length)==12' "$base/summary.json"
  grep -q '26% at 95% confidence' "$base/summary.md"
  grep -q 'Hypothesis 1' "$base/summary.md"
}
@test "empty artifact tree still summarizes all 12 cells" {
  bash "$script/summarize.sh" "$base"
  jq -e '.passes==[] and .failures==[] and (.unexercised|length)==0 and (.no_result|length)==12' "$base/summary.json"
}
@test "input validation fails before touching SDK or devices" {
  run env RUNNER_TEMP="$BATS_TEST_TMPDIR" CELL_DIR="$dir" GPU=host GPU_ARGS='[]' WORKLOAD=automobile LOAD_SECONDS=0 bash "$script/emulator-cell.sh"
  [ "$status" -eq 2 ]; [[ "$output" == *'positive integer'* ]]
}
@test "wrapper records the actual argv and unmarked 139 without an emulator" {
  cat > "$BATS_TEST_TMPDIR/fake-emulator" <<'STUB'
#!/usr/bin/env bash
printf 'fake stdout\n'; printf 'fake stderr\n' >&2
exit 139
STUB
  chmod +x "$BATS_TEST_TMPDIR/fake-emulator"
  run env CYCLE_DIR="$dir" REAL_EMULATOR="$BATS_TEST_TMPDIR/fake-emulator" bash "$script/emulator-cell.sh" --emulator-wrapper -avd medium_phone -gpu swangle
  [ "$status" -eq 139 ]
  [ "$(cat "$dir/exit-code")" = 139 ]
  jq -e '.==["-avd","medium_phone","-gpu","swangle"]' "$dir/argv.json"
  [ ! -f "$dir/kill-sent" ]
  classify
  [ "$(jq -r .outcome "$dir/result.json")" = crash ]
}
@test "raw control orchestration captures a real wait status using only stubbed SDK commands" {
  bin="$BATS_TEST_TMPDIR/bin"; sdk="$BATS_TEST_TMPDIR/sdk"
  mkdir -p "$bin" "$sdk/emulator"; touch "$BATS_TEST_TMPDIR/kvm"
  cat > "$sdk/emulator/emulator" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == -version ]]; then echo 'test emulator 37'; exit 0; fi
exit 139
STUB
  cat > "$bin/avdmanager" <<'STUB'
#!/usr/bin/env bash
if [[ $1 == list ]]; then echo 'id: 1 or "medium_phone"'; exit 0; fi
mkdir -p "$ANDROID_AVD_HOME/medium_phone.avd"
printf 'hw.ramSize=2048\nhw.cpu.ncore=2\nhw.gpu.mode=auto\n' > "$ANDROID_AVD_HOME/medium_phone.avd/config.ini"
STUB
  for cmd in sdkmanager sudo adb lscpu free find; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/$cmd"
  done
  chmod +x "$bin"/* "$sdk/emulator/emulator"
  run env PATH="$bin:$PATH" RUNNER_TEMP="$BATS_TEST_TMPDIR" CELL_DIR="$dir" KVM_DEVICE="$BATS_TEST_TMPDIR/kvm" ANDROID_HOME="$sdk" GPU=swangle GPU_ARGS='["-gpu","swangle","-feature","-Vulkan"]' WORKLOAD=raw-adb-control LOAD_SECONDS=1 CYCLES=1 SLEEP_CMD=true bash "$script/emulator-cell.sh"
  if [ "$status" -ne 0 ]; then printf '%s\n' "$output" >&2; return 1; fi
  [[ "$output" == *'::warning::Real emulator crash captured'* ]]
  jq -e '.outcome=="crash" and (.argv|index("-no-window"))!=null and .cycles_completed==0' "$dir/result.json"
}
@test "load drivers use real CLI flag shapes with injectable clocks and no sleeps" {
  bin="$BATS_TEST_TMPDIR/bin"; mkdir -p "$bin"
  export TICKS="$BATS_TEST_TMPDIR/ticks" CALLS="$BATS_TEST_TMPDIR/calls"
  echo 0 > "$TICKS"
  cat > "$bin/clock" <<'STUB'
#!/usr/bin/env bash
n=$(cat "$TICKS"); echo "$((n+1))" > "$TICKS"; echo "$n"
STUB
  for cmd in auto-mobile adb; do
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$CALLS"\n' > "$bin/$cmd"
  done
  chmod +x "$bin"/*
  for driver in automobile raw-adb heartbeat; do
    echo 0 > "$TICKS"
    run env PATH="$bin:$PATH" NOW_CMD="$bin/clock" CYCLE_DIR="$dir" SESSION_UUID=private SERIAL=emulator-5554 LOAD_SECONDS=3 SLEEP_CMD=true bash "$script/workload-$driver.sh"
    [ "$status" -eq 0 ]
  done
  grep -F -- '--commands [{"action":"type","text":"wifi"},{"action":"key","key":"enter"}]' "$CALLS"
  grep -F -- '--screenshot settled' "$CALLS"
  grep -F 'exec-out screencap -p' "$CALLS"
  grep -F 'get-state' "$CALLS"
}
@test "same-second exit markers use file ordering instead of guessing chronology" {
  exited 139; echo 200 > "$dir/shutdown-intent"
  touch -t 202601010001 "$dir/exit-time"
  touch -t 202601010002 "$dir/shutdown-intent"
  run classify; [ "$output" = crash ]
  touch -t 202601010003 "$dir/exit-time"
  run classify; [ "$output" = crash ]
  jq -e '.evidence|index("during-shutdown")!=null' "$dir/result.json"
  echo 0 > "$dir/exit-code"
  run classify; [ "$output" = shutdown ]
}
@test "nested acquisition and MCP text envelopes return the runtime serial and session" {
  jq -n '{runtime:{deviceId:"emulator-5598",session:{sessionUuid:"private-session"}}}' > "$dir/start.json"
  for shape in direct envelope; do
    if [[ $shape == envelope ]]; then
      jq -n --rawfile text "$dir/start.json" '{content:[{type:"image",data:"ignored"},{type:"text",text:$text}]}' > "$dir/envelope.json"
      mv "$dir/envelope.json" "$dir/start.json"
    fi
    run bash -c 'source "$1/lib.sh"; acquired_device "$2/start.json"' _ "$script" "$dir"
    [ "$status" -eq 0 ]; [ "$output" = $'emulator-5598\tprivate-session' ]
  done
  echo '{"deviceId":"legacy","sessionUuid":"wrong"}' > "$dir/start.json"
  run bash -c 'source "$1/lib.sh"; acquired_device "$2/start.json"' _ "$script" "$dir"
  [ "$status" -ne 0 ]
}
@test "failed load polls for a delayed wrapper exit before marking harness error" {
  cat > "$BATS_TEST_TMPDIR/exit-pause" <<'STUB'
#!/usr/bin/env bash
true "$@"
echo 200 > "$CYCLE_DIR/exit-time"
echo 139 > "$CYCLE_DIR/exit-code"
STUB
  chmod +x "$BATS_TEST_TMPDIR/exit-pause"
  run env CYCLE_DIR="$dir" SLEEP_CMD="$BATS_TEST_TMPDIR/exit-pause" bash -c 'source "$1/lib.sh"; finish_load 1' _ "$script"
  [ "$status" -eq 0 ]; [ ! -f "$dir/harness-error" ]
  # Even an independently recorded harness failure cannot erase the crash.
  touch "$dir/harness-error"
  run classify; [ "$output" = crash ]
}
@test "failed load bounds its exit wait at 60 injectable pauses" {
  run env CYCLE_DIR="$dir" SLEEP_CMD=true bash -c 'source "$1/lib.sh"; pause() { true "$@"; echo tick >> "$CYCLE_DIR/pauses"; }; finish_load 1' _ "$script"
  [ "$status" -eq 0 ]; [ -f "$dir/harness-error" ]
  [ "$(wc -l < "$dir/pauses" | tr -d ' ')" = 60 ]
}
@test "empty dumps crashpad directories and unrelated files are not crash evidence" {
  exited 1
  mkdir -p "$dir/dumps/emu-crash-1.db" "$dir/cores"
  touch "$dir/dumps/empty.dmp" "$dir/cores/core.empty" "$dir/dmesg.log"
  echo unrelated > "$dir/cores/README"
  run classify; [ "$output" = unknown-exit ]
  jq -e '.evidence==[]' "$dir/result.json"
}
@test "shutdown cannot mask a minidump core or named dmesg segfault" {
  exited 0; echo 199 > "$dir/shutdown-intent"
  echo '199 TERM' > "$dir/kill-sent"
  for kind in dump core dmesg; do
    case "$kind" in
      dump) mkdir -p "$dir/dumps"; echo dump > "$dir/dumps/emu.dmp";;
      core) mkdir -p "$dir/cores"; echo core > "$dir/cores/core.qemu.1";;
      dmesg) echo 'segfault in qemu-system-x86_64' > "$dir/dmesg.log";;
    esac
    run classify; [ "$output" = crash ]
    jq -e '.evidence|index("during-shutdown")!=null' "$dir/result.json"
    rm -rf "$dir/dumps" "$dir/cores" "$dir/dmesg.log"
  done
}
@test "host boot early-out cannot hide strong crash signatures even before wait completes" {
  touch "$dir/host-unavailable"
  echo 139 > "$dir/exit-code"
  run classify; [ "$output" = crash ]
  exited 139; touch "$dir/harness-error"
  run classify; [ "$output" = crash ]
}
@test "operation failures and hangs record rc continue and keep heartbeat evidence separate" {
  bin="$BATS_TEST_TMPDIR/bin"; mkdir -p "$bin"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  cat > "$bin/timeout" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
shift 3
"$@"
STUB
  chmod +x "$bin/timeout"
  run env PATH="$bin:$PATH" CYCLE_DIR="$dir" SLEEP_CMD=true bash -c '
    source "$1/lib.sh"
    operation failure bash -c "exit 7"
    operation hung bash -c "exit 124"
    operation next true
    finish_load 0
  ' _ "$script"
  [ "$status" -eq 0 ]
  grep -F 'failure end status=7' "$dir/ops.log"
  grep -F 'hung end status=124' "$dir/ops.log"
  grep -F 'hung op-hang' "$dir/ops.log"
  grep -F 'next end status=0' "$dir/ops.log"
  grep -F -- '-k 2 90' "$CALLS"
  [ ! -f "$dir/heartbeat-failed" ]; [ ! -f "$dir/harness-error" ]
  run classify; [ "$output" = op-hang ]
  jq -e '.evidence|index("op-hang")!=null' "$dir/result.json"
}
@test "daemon JSON cleanup kills only its pid and waits for the exact serial to disappear" {
  bin="$BATS_TEST_TMPDIR/bin"; mkdir -p "$bin"
  export CALLS="$BATS_TEST_TMPDIR/calls" DEVICES="$BATS_TEST_TMPDIR/devices"
  echo 0 > "$DEVICES"
  echo '{"pid":4242,"port":1111}' > "$dir/daemon.pid"
  cat > "$bin/kill-stub" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
STUB
  cat > "$bin/adb" <<'STUB'
#!/usr/bin/env bash
n=$(cat "$DEVICES"); echo "$((n+1))" > "$DEVICES"
echo 'List of devices attached'
if (( n < 2 )); then printf 'emulator-5554\toffline\n'; fi
printf 'emulator-55540\tdevice\nemulator-5598\tdevice\n'
STUB
  chmod +x "$bin"/*
  run env PATH="$bin:$PATH" CYCLE_DIR="$dir" SERIAL=emulator-5554 KILL_CMD="$bin/kill-stub" AUTOMOBILE_DAEMON_PID_FILE_PATH="$dir/daemon.pid" SLEEP_CMD=true bash -c 'source "$1/lib.sh"; stop_private_daemon; await_device_gone' _ "$script"
  [ "$status" -eq 0 ]; [ "$(cat "$CALLS")" = '-TERM 4242' ]; [ "$(cat "$DEVICES")" = 3 ]
  echo '{"pid":0}' > "$dir/daemon.pid"
  run env AUTOMOBILE_DAEMON_PID_FILE_PATH="$dir/daemon.pid" KILL_CMD="$bin/kill-stub" bash -c 'source "$1/lib.sh"; stop_private_daemon' _ "$script"
  [ "$status" -ne 0 ]; [ "$(wc -l < "$CALLS" | tr -d ' ')" = 1 ]
}
@test "device cleanup is bounded and cannot permit another cycle while serial remains" {
  bin="$BATS_TEST_TMPDIR/bin"; mkdir -p "$bin"
  printf '#!/usr/bin/env bash\nprintf "emulator-5554\\toffline\\n"\n' > "$bin/adb"
  chmod +x "$bin/adb"
  run env PATH="$bin:$PATH" CYCLE_DIR="$dir" SERIAL=emulator-5554 SLEEP_CMD=true bash -c 'source "$1/lib.sh"; pause() { true "$@"; echo tick >> "$CYCLE_DIR/pauses"; }; await_device_gone' _ "$script"
  [ "$status" -ne 0 ]; [ "$(wc -l < "$dir/pauses" | tr -d ' ')" = 30 ]
}
@test "missing artifacts and artifact without result are NO RESULT separately from unexercised" {
  mkdir -p "$base/emulator-sigsegv-host-heartbeat-only"
  echo partial > "$base/emulator-sigsegv-host-heartbeat-only/stdout.pending"
  touch "$dir/host-unavailable"; classify
  bash "$script/summarize.sh" "$base"
  jq -e '.unexercised==["swangle-automobile"] and (.no_result|length)==11 and (.no_result|index("host-heartbeat-only"))!=null' "$base/summary.json"
  grep -F 'NO RESULT (cell killed or timed out)' "$base/summary.md"
}
@test "boot timeout cannot exceed the 600 second boot bound" {
  run env RUNNER_TEMP="$BATS_TEST_TMPDIR" CELL_DIR="$dir" GPU=swangle GPU_ARGS='[]' WORKLOAD=automobile BOOT_SECONDS=601 bash "$script/emulator-cell.sh"
  [ "$status" -eq 2 ]; [[ "$output" == *'BOOT_SECONDS must be <= 600'* ]]
}
prepare_cell_stubs() {
  bin="$BATS_TEST_TMPDIR/bin"; sdk="$BATS_TEST_TMPDIR/sdk"
  mkdir -p "$bin" "$sdk/emulator"; touch "$BATS_TEST_TMPDIR/kvm"
  export CALLS="$BATS_TEST_TMPDIR/calls" TICKS="$BATS_TEST_TMPDIR/ticks"
  echo 1000 > "$TICKS"
  cat > "$sdk/emulator/emulator" <<'STUB'
#!/usr/bin/env bash
echo 'test emulator version'
STUB
  cat > "$bin/clock" <<'STUB'
#!/usr/bin/env bash
n=$(cat "$TICKS"); echo "$((n+1))" > "$TICKS"; echo "$n"
STUB
  cat > "$bin/avdmanager" <<'STUB'
#!/usr/bin/env bash
if [[ $1 == list ]]; then echo 'id: 1 or "medium_phone"'; exit 0; fi
mkdir -p "$ANDROID_AVD_HOME/medium_phone.avd"
echo hw.ramSize=2048 > "$ANDROID_AVD_HOME/medium_phone.avd/config.ini"
STUB
  cat > "$bin/auto-mobile" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
if [[ "$*" == *getAndroid* ]]; then
  cat "$ACQUISITION"
  mkdir -p "${AUTOMOBILE_DAEMON_PID_FILE_PATH%/*}"
  echo '{"pid":999999,"socket":"private"}' > "$AUTOMOBILE_DAEMON_PID_FILE_PATH"
elif [[ "$*" == *killDevice* ]]; then
  echo 0 > "$CYCLE_DIR/exit-code"
  echo "$(( $(cat "$CYCLE_DIR/shutdown-intent") + 1 ))" > "$CYCLE_DIR/exit-time"
fi
STUB
  cat > "$bin/adb" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
if [[ "$*" == *getprop* ]]; then echo 1; fi
if [[ "$1" == devices ]]; then echo 'List of devices attached'; fi
STUB
  cat > "$bin/kill-stub" <<'STUB'
#!/usr/bin/env bash
printf 'kill %s\n' "$*" >> "$CALLS"
STUB
  for cmd in sdkmanager sudo lscpu free find; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/$cmd"
  done
  chmod +x "$bin"/* "$sdk/emulator/emulator"
}
run_stubbed_cell() {
  env PATH="$bin:$PATH" RUNNER_TEMP="$BATS_TEST_TMPDIR" CELL_DIR="$dir" KVM_DEVICE="$BATS_TEST_TMPDIR/kvm" ANDROID_HOME="$sdk" GPU=swangle GPU_ARGS='["-gpu","swangle"]' WORKLOAD=automobile LOAD_SECONDS=1 CYCLES=1 NOW_CMD="$bin/clock" SLEEP_CMD=true KILL_CMD="$bin/kill-stub" bash "$script/emulator-cell.sh"
}
@test "automobile orchestration uses schema-valid acquisition and starts logcat on final serial" {
  prepare_cell_stubs
  export ACQUISITION="$BATS_TEST_TMPDIR/acquisition.json"
  for shape in direct envelope; do
    jq -n '{runtime:{deviceId:"emulator-5598",session:{sessionUuid:"private-session"}}}' > "$ACQUISITION"
    if [[ $shape == envelope ]]; then
      jq -n --rawfile text "$ACQUISITION" '{content:[{type:"text",text:$text}]}' > "$ACQUISITION.tmp"
      mv "$ACQUISITION.tmp" "$ACQUISITION"
    fi
    rm -rf "$dir"; mkdir -p "$dir"
    run run_stubbed_cell
    if [ "$status" -ne 0 ]; then printf '%s\n' "$output" >&2; return 1; fi
    jq -e '.outcome=="shutdown" and .cycles_completed==1' "$dir/result.json"
  done
  grep -F -- '--cli getAndroid --avdName medium_phone --boot-timeout-ms 600000' "$CALLS"
  ! grep -E 'startDevice|getAndroid.*--platform' "$CALLS"
  grep -F -- '-s emulator-5598 wait-for-device logcat -b all' "$CALLS"
  ! grep -F -- '-s emulator-5554' "$CALLS"
  grep -F -- '--session-uuid private-session killDevice' "$CALLS"
  grep -F 'kill -TERM 999999' "$CALLS"
  jq -e '.[]|select(.name=="getAndroid")|.inputSchema|.additionalProperties==false and .properties.avdName.type=="string" and .properties.bootTimeoutMs.maximum>=600000 and (.properties|has("platform")|not)' "$BATS_TEST_DIRNAME/../../schemas/tool-definitions.json"
}
@test "TERM interrupts a blocked setup command and writes a result without waiting for it" {
  prepare_cell_stubs
  export BLOCK_FIFO="$BATS_TEST_TMPDIR/block" BLOCK_PID="$BATS_TEST_TMPDIR/blocked.pid"
  mkfifo "$BLOCK_FIFO"
  cat > "$bin/avdmanager" <<'STUB'
#!/usr/bin/env bash
exec 2>/dev/null 3>&-
echo "$$" > "$BLOCK_PID"
kill -TERM "$PPID"
read -r _ < "$BLOCK_FIFO"
STUB
  chmod +x "$bin/avdmanager"
  run timeout -k 1 5 bash -c '"$@"' _ env PATH="$bin:$PATH" RUNNER_TEMP="$BATS_TEST_TMPDIR" CELL_DIR="$dir" KVM_DEVICE="$BATS_TEST_TMPDIR/kvm" ANDROID_HOME="$sdk" GPU=swangle GPU_ARGS='[]' WORKLOAD=automobile LOAD_SECONDS=1 NOW_CMD="$bin/clock" SLEEP_CMD=true bash "$script/emulator-cell.sh"
  # Release only our blocked stub after the cell has returned.
  if [[ "$status" -eq 1 && -f "$BLOCK_PID" ]]; then printf 'release\n' > "$BLOCK_FIFO"; fi
  [ "$status" -eq 1 ]
  jq -e '.outcome=="harness-error"' "$dir/result.json"
  [ -f "$dir/harness-error" ]
}
@test "collection copies only non-empty regular minidumps and cores without crashpad dirs" {
  root="$BATS_TEST_TMPDIR/files"
  mkdir -p "$root/emu-crash-1.db" "$root/fake.dmp" "$dir/dumps" "$dir/cores"
  touch -t 202601010001 "$dir/start-time"
  touch "$root/empty.dmp" "$root/core.empty"
  echo dump > "$root/emu-crash-1.db/real.dmp"
  echo core > "$root/core.qemu.42"
  echo database > "$root/emu-crash-1.db/settings.dat"
  echo already-collected > "$dir/cores/core.existing"
  # The harness runs on GNU/Linux; adapt only cp's backup flag on BSD hosts.
  bin="$BATS_TEST_TMPDIR/bin"; mkdir -p "$bin"
  export REAL_CP
  REAL_CP=$(command -v cp)
  cat > "$bin/cp" <<'STUB'
#!/usr/bin/env bash
if [[ ${1:-} == --backup=numbered ]]; then shift; fi
exec "$REAL_CP" "$@"
STUB
  chmod +x "$bin/cp"
  run env PATH="$bin:$PATH" CELL_DIR="$dir" CYCLE_DIR="$dir" SLEEP_CMD=true bash -c 'source "$1/lib.sh"; collect_crash_files "*.dmp" dumps "$2" "$CYCLE_DIR"; collect_crash_files "core.*" cores "$2" "$CYCLE_DIR"' _ "$script" "$root"
  [ "$status" -eq 0 ]
  [ "$(ls "$dir/dumps")" = real.dmp ]
  [ "$(ls "$dir/cores")" = $'core.existing\ncore.qemu.42' ]
  cmp "$root/emu-crash-1.db/real.dmp" "$dir/dumps/real.dmp"
  cmp "$root/core.qemu.42" "$dir/cores/core.qemu.42"
}
@test "an outcome with no evidence classifies under Bash 3.2 set -u (empty array)" {
  # Bash 3.2 aborts on an empty "${arr[@]}" under set -u; Fast Validation's shell-portability
  # check flagged classify-exit.sh:36 for exactly this. Run the real script under the system bash.
  [ -x /bin/bash ] || skip "system Bash is unavailable"
  touch "$dir/load-survived"
  run /bin/bash "$script/classify-exit.sh" "$dir"
  [ "$status" -eq 0 ]
  [ "$output" = survived ]
  jq -e '.evidence==[]' "$dir/result.json"
}
