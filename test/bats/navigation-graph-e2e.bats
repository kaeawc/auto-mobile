#!/usr/bin/env bats

SCRIPT="scripts/android/navigation-graph-e2e.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  export HOME="${MOCK_BIN}/home"
  export CALLS="${MOCK_BIN}/calls"
  export SCREEN_FILE="${MOCK_BIN}/screen"
  export GRAPH_ATTEMPTS="${MOCK_BIN}/graph-attempts"
  export SESSION_UUID="9f860000-0000-4000-8000-000000000000"
  export PATH="${MOCK_BIN}:${PATH}"
  cat > "${MOCK_BIN}/adb" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'adb %s\n' "$*" >> "$CALLS"
case "$*" in
  devices) printf 'List of devices attached\nemulator-5554 device\n' ;;
  '-s emulator-5554 shell pm clear dev.jasonpearson.automobile.playground') echo Success ;;
  '-s emulator-5554 shell am start -W -n dev.jasonpearson.automobile.playground/.MainActivity') ;;
  *) exit 91 ;;
esac
STUB
  cat > "${MOCK_BIN}/sleep" <<'STUB'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >> "$CALLS"
STUB
  cat > "${MOCK_BIN}/auto-mobile" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'cli %s\n' "$*" >> "$CALLS"
if [[ "$1" == --daemon ]]; then
  [[ "$2" == release-session && "$3" == "$SESSION_UUID" && "$AUTOMOBILE_DAEMON_TIMEOUT_MS" == 2000 ]]
  exit $?
fi
[[ "$1 $2 $3" == '--debug --embedded-sdk --cli' ]] || exit 92
if [[ "$4" == getAndroid ]]; then
  [[ "$5 $6 $7 $8" == '--deviceId emulator-5554 --automation-ready-timeout-ms 120000' ]] || exit 93
  jq -cn --arg uuid "$SESSION_UUID" '{runtime:{session:{sessionUuid:$uuid}}}'
  exit 0
fi
[[ "$4" == --session-uuid && "$5" == "$SESSION_UUID" ]] || exit 94
shift 5
command="$1"
shift
[[ "$*" == '--platform android --deviceId emulator-5554'* ]] || exit 95
shift 4
emit() { jq -cn --argjson result "$1" '{content:[{type:"text",text:($result|tojson)}]}'; }
case "$command" in
  launchApp) emit '{"success":true}' ;;
  explore)
    [[ "$*" == '--maxInteractions 40 --timeoutMs 300000 --packageName dev.jasonpearson.automobile.playground' ]] || exit 96
    if [[ "${EXPLORE_FAIL:-}" == cli ]]; then exit 23; fi
    if [[ "${EXPLORE_FAIL:-}" == result ]]; then emit '{"success":false}'; exit 0; fi
    echo DemoIndexDestination > "$SCREEN_FILE"
    emit '{"success":true,"cancelled":false}'
    ;;
  observe)
    screen="$(cat "$SCREEN_FILE")"
    if [[ "${WRONG_OBSERVATION:-0}" == 1 ]]; then screen=HomeDestination; fi
    emit "$(jq -cn --arg screen "$screen" '{screenIdentity:{components:{navigationRoute:$screen}}}')"
    ;;
  getNavigationGraph)
    [[ "$*" == '--appId dev.jasonpearson.automobile.playground' ]] || exit 97
    count=0
    [[ ! -f "$GRAPH_ATTEMPTS" ]] || count="$(cat "$GRAPH_ATTEMPTS")"
    count=$((count + 1))
    echo "$count" > "$GRAPH_ATTEMPTS"
    if [[ "${GRAPH_MISSING:-0}" == 1 || ( "${GRAPH_RETRY:-0}" == 1 && "$count" == 1 ) ]]; then
      emit '{"screens":[],"transitions":[]}'
      exit 0
    fi
    screen="$(cat "$SCREEN_FILE")"
    if [[ "${WRONG_ARRIVAL:-0}" == 1 && "$count" -gt 1 ]]; then screen=HomeDestination; fi
    # Extra nodes/edges deliberately prove membership, not exact counts.
    graph="$(jq -cn --arg screen "$screen" '{currentScreen:$screen,screens:(["ExtraDestination","DemoIndexDestination","HomeDestination","LoginDestination","OnboardingDestination"]|map({name:.})),transitions:[{from:"LoginDestination",to:"HomeDestination",type:"tool",tool:"tapOn",args:{selector:{text:"Continue as Guest"}}},{from:"HomeDestination",to:"DemoIndexDestination",type:"tool",tool:"tapOn",args:{selector:{text:"Demos"}}},{from:"HomeDestination",to:"ExtraDestination"}]}')"
    emit "$graph"
    ;;
  navigateTo)
    case "$2" in
      HomeDestination)
        echo HomeDestination > "$SCREEN_FILE"
        emit '{"success":true,"currentScreen":"HomeDestination","stepsExecuted":1}'
        ;;
      DemoIndexDestination)
        [[ "$(cat "$SCREEN_FILE")" == HomeDestination ]] || exit 98
        echo DemoIndexDestination > "$SCREEN_FILE"
        emit '{"success":true,"currentScreen":"DemoIndexDestination","stepsExecuted":1}'
        ;;
      OnboardingDestination)
        [[ "$(cat "$SCREEN_FILE")" == HomeDestination ]] || exit 99
        case "${NEGATIVE_MODE:-expected}" in
          expected) emit '{"success":false,"currentScreen":"HomeDestination","targetScreen":"OnboardingDestination","stepsExecuted":0,"error":"No known path from Home to Onboarding"}'; exit 1 ;;
          success) emit '{"success":true,"currentScreen":"OnboardingDestination","stepsExecuted":1}' ;;
          wrong-error) emit '{"success":false,"currentScreen":"HomeDestination","targetScreen":"OnboardingDestination","stepsExecuted":0,"error":"Device disconnected"}' ;;
          steps) emit '{"success":false,"currentScreen":"HomeDestination","targetScreen":"OnboardingDestination","stepsExecuted":1,"error":"No known path"}' ;;
        esac
        ;;
      *) exit 100 ;;
    esac
    ;;
  *) exit 101 ;;
esac
STUB
  chmod +x "${MOCK_BIN}/adb" "${MOCK_BIN}/auto-mobile" "${MOCK_BIN}/sleep"
}

teardown() {
  rm -rf "$MOCK_BIN"
}

@test "explores and replays learned Home to Demos edge with acquired session and releases it" {
  run bash "$SCRIPT" emulator-5554
  [ "$status" -eq 0 ]
  [[ "$output" == *'PASS: expected graph nodes are present'* ]]
  [[ "$output" == *'PASS: login to home and Home to Demos learned edges are present'* ]]
  [[ "$output" == *'PASS: Home to Demos replay succeeds in one step'* ]]
  [[ "$output" == *'PASS: observed arrival at DemoIndexDestination'* ]]
  [[ "$output" == *'PASS: unreachable onboarding reports No known path with zero steps'* ]]
  [ "$(grep -c -- '--daemon release-session' "$CALLS")" -eq 1 ]
  ! grep -q '^adb devices' "$CALLS"
}

@test "selects the first connected device and retries incomplete graph reads" {
  run env GRAPH_RETRY=1 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -q '^adb devices' "$CALLS"
  [ "$(grep -c '^sleep 2$' "$CALLS")" -eq 1 ]
}

@test "negative replay rejects success, unrelated errors, and nonzero steps" {
  for mode in success wrong-error steps; do
    run env NEGATIVE_MODE="$mode" bash "$SCRIPT" emulator-5554
    [ "$status" -eq 1 ]
    [[ "$output" == *'FAIL: unreachable onboarding reports No known path with zero steps'* ]]
  done
}

@test "explore CLI and structured failures stop before graph reads and release session" {
  for mode in cli result; do
    : > "$CALLS"
    run env EXPLORE_FAIL="$mode" bash "$SCRIPT" emulator-5554
    [ "$status" -eq 1 ]
    [[ "$output" == *'FAIL: explore'* ]]
    ! grep -q ' getNavigationGraph ' "$CALLS"
    [ "$(grep -c -- '--daemon release-session' "$CALLS")" -eq 1 ]
  done
}

@test "missing graph membership fails after five bounded reads" {
  run env GRAPH_MISSING=1 bash "$SCRIPT" emulator-5554
  [ "$status" -eq 1 ]
  [[ "$output" == *'FAIL: expected graph nodes and learned edges'* ]]
  [ "$(cat "$GRAPH_ATTEMPTS")" -eq 5 ]
  [ "$(grep -c '^sleep 2$' "$CALLS")" -eq 4 ]
  ! grep -q ' navigateTo ' "$CALLS"
}

@test "replay success without observed destination fails the arrival assertion" {
  run env WRONG_ARRIVAL=1 bash "$SCRIPT" emulator-5554
  [ "$status" -eq 1 ]
  [[ "$output" == *'FAIL: observed arrival at DemoIndexDestination'* ]]
  ! grep -q -- '--targetScreen OnboardingDestination' "$CALLS"
}

@test "arrival requires the fresh observation to identify the destination" {
  run env WRONG_OBSERVATION=1 bash "$SCRIPT" emulator-5554
  [ "$status" -eq 1 ]
  [[ "$output" == *'FAIL: observed arrival at DemoIndexDestination'* ]]
  ! grep -q -- '--targetScreen OnboardingDestination' "$CALLS"
}
