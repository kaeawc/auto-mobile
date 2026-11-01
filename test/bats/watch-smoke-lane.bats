#!/usr/bin/env bats
# All external commands are stubs. Never boots a simulator or starts a daemon.
setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$ROOT/scripts/ios/watch-smoke-lane.sh"
  export WATCH_SMOKE_LOG_DIR="$BATS_TEST_TMPDIR/logs"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  mkdir -p "$BATS_TEST_TMPDIR/bin" "$BATS_TEST_TMPDIR/aux"
  chmod 700 "$BATS_TEST_TMPDIR/aux"
  export AUTOMOBILE_AUX_SOCKET_DIR="$BATS_TEST_TMPDIR/aux"
  export XCRUN_BIN="$BATS_TEST_TMPDIR/bin/xcrun"
  export AUTO_MOBILE_CMD="$BATS_TEST_TMPDIR/bin/cli --debug --embedded-sdk --cli"
  export WATCH_SMOKE_DAEMON_PORT=45678
  export LSOF_BIN="$BATS_TEST_TMPDIR/bin/lsof"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
  cat > "$XCRUN_BIN" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
case "$*" in
  'simctl list runtimes available watchOS --json')
    if [[ ${NO_RUNTIME:-} == 1 ]]; then echo '{"runtimes":[]}'; else
      jq -n '{runtimes:[{identifier:"com.apple.CoreSimulator.SimRuntime.watchOS-26-5", version:"26.5",isAvailable:true,supportedDeviceTypes:[{productFamily:"Apple Watch",identifier:"watch-type"}]}]}'
    fi ;;
  'simctl create '*) echo '11111111-2222-3333-4444-555555555555' ;;
  'simctl bootstatus '*) [[ ${BOOT_FAIL:-} != 1 ]] ;;
  'simctl io '*) touch "${@: -1}" ;;
esac
STUB
  cat > "$BATS_TEST_TMPDIR/bin/cli" <<'STUB'
#!/usr/bin/env bash
printf 'cli %s aux=%s socket=%s\n' "$*" "$AUTOMOBILE_AUX_SOCKET_DIR" "$AUTOMOBILE_DAEMON_SOCKET_PATH" >> "$CALLS"
if [[ "$*" == *'--daemon start'* ]]; then
  [[ "$*" == "--debug --embedded-sdk --daemon start --debug --embedded-sdk --port "* ]] || exit 1
  port="${@: -1}"
  [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 40000 && port <= 65535)) || exit 1
  [[ -z ${WATCH_SMOKE_DAEMON_PORT:-} || "$port" == "$WATCH_SMOKE_DAEMON_PORT" ]] || exit 1
  [[ ${START_FAIL:-} != 1 ]]
  exit $?
fi
for arg in "$@"; do
  case "$arg" in --port | --port=*) exit 1 ;; esac
done
if [[ "$*" != *--daemon* ]]; then
  [[ "$*" =~ ^--debug\ --embedded-sdk\ --cli\ (startDevice\ --platform\ watchos|--session-uuid\ watch-session\ (observe|tapOn))\ --deviceId\  ]] || exit 1
  [[ "$AUTOMOBILE_DAEMON_SOCKET_PATH" == "$AUTOMOBILE_AUX_SOCKET_DIR/control.sock" ]] || exit 1
fi
case "$*" in
  *getApple*) echo "getApple must not acquire watch sessions" >&2; exit 1 ;;
  *startDevice*)
    [[ "$*" == "--debug --embedded-sdk --cli startDevice --platform watchos --deviceId 11111111-2222-3333-4444-555555555555" ]] || exit 1
    if [[ ${START_DEVICE_FAIL:-} == 1 ]]; then echo 'stub acquisition failure' >&2; exit 1; fi
    if [[ ${NO_SESSION:-} == 1 ]]; then echo '{"success":true}'; exit; fi
    if [[ ${TOP_LEVEL_SESSION:-} == 1 ]]; then
      echo '{"sessionUuid":"watch-session"}'
    elif [[ ${PLAIN_SESSION:-} == 1 ]]; then
      echo '{"runtime":{"session":{"sessionUuid":"watch-session"}},"isReady":true,"acquisition":"already-booted"}'
    else
      jq -n '{runtime:{session:{sessionUuid:"watch-session"}},isReady:true,acquisition:"already-booted"} | {content:[{type:"text",text:(.|tojson)}],structuredContent:.}'
    fi ;;
  *release-session*)
    printf 'release-cmd=%s\n' "${AUTO_MOBILE_CMD:-}" >> "$CALLS"
    [[ ${RELEASE_FAIL:-} != 1 ]] ;;
  *observe*)
    [[ "$*" == *'--session-uuid watch-session observe --deviceId 11111111-2222-3333-4444-555555555555 --platform watchos' ]] || exit 1
    [[ "$*" != *--project* ]] || exit 1
    if [[ ${SCREENSHOT_ONLY:-} == 1 ]]; then
      echo '{"screenshotPath":"stub.png","hierarchyUnavailable":{"platform":"watchos","message":"no runner"}}'
      exit
    fi
    if [[ -f "$CALLS.tapped" ]]; then id=watch-smoke-next; else id=watch-smoke-row; fi
    if [[ ${MISSING_ROW:-} == 1 && ! -f "$CALLS.tapped" ]]; then id=watch-smoke-row-extra; fi
    if [[ ${MISSING_NEXT:-} == 1 && -f "$CALLS.tapped" ]]; then id=missing; fi
    if [[ ${FULL_HIERARCHY:-} == 1 ]]; then
      payload="$(jq -n --arg id "$id" '{screenshotPath:"stub.png",viewHierarchy:{hierarchy:{node:{"$":{"resource-id":$id}}}}}')"
    elif [[ ${SKELETON_HIERARCHY:-} == 1 ]]; then
      payload="$(jq -n --arg id "$id" '{screenshotPath:"stub.png",skeleton:[{elementId:$id,label:"Smoke row",bounds:[0,0,100,40],affordances:["tap"]}]}')"
    elif [[ ${CONTEXT_ELEMENT_ID:-} == 1 ]]; then
      payload="$(jq -n --arg id "$id" '{screenshotPath:"stub.png",context:[{elementId:$id,label:"Smoke row",bounds:[2,144,206,200],affordances:[]}]}')"
    else
      payload="$(jq -n --arg id "$id" '{screenshotPath:"stub.png",skeleton:[],context:[{label:$id,bounds:[2,144,206,200],affordances:[]}]}')"
    fi
    if [[ ${OBSERVE_ENVELOPE:-} == 1 ]]; then
      jq -n --arg payload "$payload" '{content:[{type:"text",text:$payload}]}'
    else
      echo "$payload"
    fi ;;

  *tapOn*)
    [[ "$*" == *'--session-uuid watch-session tapOn --deviceId 11111111-2222-3333-4444-555555555555 --selector {"text":"watch-smoke-row"}' ]] || exit 1
    touch "$CALLS.tapped"; echo '{"success":true}' ;;
esac
STUB
  cat > "$BATS_TEST_TMPDIR/bin/bun" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == run ]] || exit 1
shift 2
exec "$(dirname "$0")/cli" "$@"
STUB
  cat > "$BATS_TEST_TMPDIR/bin/xcodebuild" <<'STUB'
#!/usr/bin/env bash
printf 'build %s\n' "$*" >> "$CALLS"
STUB
  cat > "$LSOF_BIN" <<'STUB'
#!/usr/bin/env bash
printf 'lsof %s\n' "$*" >> "$CALLS"
[[ ${PORT_IN_USE:-} == 1 ]]
STUB
  chmod +x "$LSOF_BIN" "$XCRUN_BIN" "$BATS_TEST_TMPDIR/bin/cli" "$BATS_TEST_TMPDIR/bin/bun" "$BATS_TEST_TMPDIR/bin/xcodebuild"
}

@test "usage rejects missing argument and invalid version before xcrun" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *usage:* ]]
  run bash "$SCRIPT" not-a-version
  [ "$status" -eq 2 ]
  [ ! -f "$CALLS" ]
}

@test "refuses missing, default and non-private aux paths before xcrun" {
  unset AUTOMOBILE_AUX_SOCKET_DIR
  run bash "$SCRIPT" latest
  [ "$status" -eq 2 ]
  [[ "$output" == *AUTOMOBILE_AUX_SOCKET_DIR* ]]
  export AUTOMOBILE_AUX_SOCKET_DIR=/tmp
  run bash "$SCRIPT" latest
  [ "$status" -eq 2 ]
  export AUTOMOBILE_AUX_SOCKET_DIR="$BATS_TEST_TMPDIR/aux"
  chmod 755 "$AUTOMOBILE_AUX_SOCKET_DIR"
  run bash "$SCRIPT" latest
  [ "$status" -eq 2 ]
  [ ! -f "$CALLS" ]
}

@test "no matching runtime skips without creating a simulator or daemon" {
  export NO_RUNTIME=1
  run bash "$SCRIPT" 26
  [ "$status" -eq 3 ] || { echo "$output"; return 1; }
  ! grep -q 'simctl create\|cli ' "$CALLS" || return 1
}

@test "smoke uses label-only context, text tap, one owned UDID, private daemon and cleanup" {
  export AUTOMOBILE_DAEMON_SOCKET_PATH=/tmp/forbidden-resident.sock
  run bash "$SCRIPT" latest
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *watch-smoke-lane:\ PASS* ]]
  [ "$(grep -c '^simctl create ' "$CALLS")" -eq 1 ]
  grep -Eq 'watch-smoke-26.5-runlocal-epoch[0-9]+-[0-9]+ watch-type ' "$CALLS"
  ! grep -q getApple "$CALLS" || return 1
  grep -q '^cli --debug --embedded-sdk --cli startDevice --platform watchos --deviceId 11111111-2222-3333-4444-555555555555 ' "$CALLS"
  grep -q '^cli --debug --embedded-sdk --daemon start --debug --embedded-sdk --port 45678 aux=' "$CALLS"
  ! grep -- '^cli ' "$CALLS" | grep -v -- '--daemon start' | grep -q -- '--port' || return 1
  [ "$(grep -c -- '--session-uuid watch-session observe --deviceId 11111111-2222-3333-4444-555555555555' "$CALLS")" -eq 2 ]
  grep -Fq -- '--selector {"text":"watch-smoke-row"}' "$CALLS"
  [ "$(grep -c -- '--daemon release-session watch-session' "$CALLS")" -eq 1 ]
  release_line="$(grep -n -- '--daemon release-session' "$CALLS" | cut -d: -f1)"
  stop_line="$(grep -n -- '--daemon stop' "$CALLS" | cut -d: -f1)"
  [ "$release_line" -lt "$stop_line" ]
  grep -q 'cli --debug --embedded-sdk --daemon stop aux=.*/lane\.' "$CALLS"
  ! grep -q 'forbidden-resident' "$CALLS" || return 1
  grep -q '^simctl shutdown 11111111-2222-3333-4444-555555555555$' "$CALLS"
  grep -q '^simctl delete 11111111-2222-3333-4444-555555555555$' "$CALLS"
}

@test "failed next-screen check captures failure screenshot and cleans up" {
  export MISSING_NEXT=1
  run bash "$SCRIPT" 26.5
  [ "$status" -eq 1 ]
  [[ "$output" == *'missing identifier watch-smoke-next'* ]]
  [ -f "$WATCH_SMOKE_LOG_DIR/failure.png" ] || { echo "$output"; return 1; }
  grep -q '^simctl delete 11111111-2222-3333-4444-555555555555$' "$CALLS"
  grep -q 'cli --debug --embedded-sdk --daemon stop' "$CALLS"
}

@test "default CLI base is exported to the session release call" {
  unset AUTO_MOBILE_CMD
  run bash "$SCRIPT" latest
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  grep -Fxq 'release-cmd=bun run src/index.ts --debug --embedded-sdk --cli' "$CALLS"
  [ "$(grep -c '^cli --daemon release-session watch-session ' "$CALLS")" -eq 1 ]
}

@test "caller multi-word CLI base is preserved and exported to session release" {
  export AUTO_MOBILE_CMD="bun run custom.ts --debug --embedded-sdk --cli"
  run bash "$SCRIPT" latest
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  grep -Fxq "release-cmd=$AUTO_MOBILE_CMD" "$CALLS"
  [ "$(grep -c '^cli --daemon release-session watch-session ' "$CALLS")" -eq 1 ]
}

@test "boot failure cleans up owned simulator without starting daemon" {
  export BOOT_FAIL=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 1 ]
  grep -q '^simctl delete 11111111-2222-3333-4444-555555555555$' "$CALLS"
  ! grep -q '^cli ' "$CALLS" || return 1
}

@test "failed first CLI call still stops private daemon and deletes simulator" {
  export START_DEVICE_FAIL=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 1 ]
  [[ "$output" == *'startDevice CLI failed'* ]]
  ! grep -Eq 'observe|tapOn|release-session' "$CALLS" || return 1
  [ "$(grep -c -- '--daemon stop' "$CALLS")" -eq 1 ]
  grep -q 'cli --debug --embedded-sdk --daemon stop aux=.*/lane\.' "$CALLS"
  grep -q '^simctl delete 11111111-2222-3333-4444-555555555555$' "$CALLS"
  [ -z "$(find "$BATS_TEST_TMPDIR/aux" -mindepth 1 -print -quit)" ]
}

@test "top-level session UUID and MCP observe envelope retain identifier checks" {
  export TOP_LEVEL_SESSION=1 OBSERVE_ENVELOPE=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  grep -q -- '--daemon release-session watch-session' "$CALLS"
}


@test "plain startDevice runtime session UUID is accepted" {
  export PLAIN_SESSION=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  grep -q -- '--daemon release-session watch-session' "$CALLS"
}

@test "normalized full hierarchy resource-id remains accepted" {
  export FULL_HIERARCHY=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "context elementId remains accepted when label differs and skeleton is absent" {
  export CONTEXT_ELEMENT_ID=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "skeleton elementId remains accepted" {
  export SKELETON_HIERARCHY=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "context label must match exactly before tapping" {
  export MISSING_ROW=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 1 ]
  [[ "$output" == *'missing identifier watch-smoke-row'* ]]
  ! grep -q tapOn "$CALLS" || return 1
}

@test "missing acquired UUID refuses every later tool call and cleans up" {
  export NO_SESSION=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 1 ]
  [[ "$output" == *'startDevice returned no session UUID; refusing sessionless calls'* ]]
  ! grep -Eq 'observe|tapOn|release-session' "$CALLS" || return 1
  grep -q -- '--daemon stop' "$CALLS"
  grep -q '^simctl delete ' "$CALLS"
}

@test "screenshot-only observe fails clearly before identifier check or tap and releases" {
  export SCREENSHOT_ONLY=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 1 ]
  [[ "$output" == *'watchOS observe returned no hierarchy for session watch-session'* ]]
  [[ "$output" != *'missing identifier'* ]]
  ! grep -q tapOn "$CALLS" || return 1
  grep -q -- '--daemon release-session watch-session' "$CALLS"
  grep -q -- '--daemon stop' "$CALLS"
  grep -q '^simctl delete ' "$CALLS"
}

@test "session release failure fails the smoke but still stops daemon and deletes simulator" {
  export RELEASE_FAIL=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 1 ]
  [[ "$output" == *'warning: could not release session watch-session'* ]]
  grep -q -- '--daemon stop' "$CALLS"
  grep -q '^simctl delete ' "$CALLS"
}

@test "refuses port 3000 before any external command" {
  export WATCH_SMOKE_DAEMON_PORT=3000
  run bash "$SCRIPT" latest
  [ "$status" -eq 2 ]
  [ ! -f "$CALLS" ]
}

@test "refuses ports below 40000 and invalid numeric ports" {
  for port in 39999 nope 65536 ""; do
    export WATCH_SMOKE_DAEMON_PORT="$port"
    run bash "$SCRIPT" latest
    [ "$status" -eq 2 ]
    [ ! -f "$CALLS" ]
  done
}

@test "refuses a listening port without starting or stopping a daemon" {
  export PORT_IN_USE=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 1 ]
  [[ "$output" == *'port 45678 is already listening'* ]]
  grep -q '^lsof -nP -iTCP:45678 -sTCP:LISTEN$' "$CALLS"
  ! grep -Eq '^cli |^simctl ' "$CALLS" || return 1
}

@test "failed explicit daemon start still stops private daemon and cleans simulator" {
  export START_FAIL=1
  run bash "$SCRIPT" latest
  [ "$status" -eq 1 ]
  [[ "$output" == *'private daemon start failed'* ]]
  grep -q -- '--daemon stop aux=.*/lane\.' "$CALLS"
  ! grep -Eq 'getApple|startDevice' "$CALLS" || return 1
  grep -q '^simctl delete ' "$CALLS"
}

@test "private daemon port override reaches explicit start" {
  export WATCH_SMOKE_DAEMON_PORT=45679
  run bash "$SCRIPT" latest
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  grep -q -- '--daemon start --debug --embedded-sdk --port 45679' "$CALLS"
}

@test "derived default daemon port stays in the private range" {
  unset WATCH_SMOKE_DAEMON_PORT
  run bash "$SCRIPT" latest
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  grep -Eq -- '--daemon start --debug --embedded-sdk --port [0-9]{5} aux=' "$CALLS"
}
