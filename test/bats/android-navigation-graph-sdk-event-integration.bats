#!/usr/bin/env bats

SCRIPT="scripts/android/navigation-graph-sdk-event-integration.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIGINAL_PATH="$PATH"
  ORIGINAL_HOME="$HOME"
  export HOME="${MOCK_BIN}/home"
  export ADB_LOG="${MOCK_BIN}/adb.log"
  export AUTO_MOBILE_LOG="${MOCK_BIN}/auto-mobile.log"
  export SESSION_BOUND_FILE="${MOCK_BIN}/session-bound"
  export EVENT_TRIGGERED_FILE="${MOCK_BIN}/event-triggered"
  export EVENT_DESTINATION_FILE="${MOCK_BIN}/event-destination"
  export GRAPH_ATTEMPTS_FILE="${MOCK_BIN}/graph-attempts"
  export ROOTED_FILE="${MOCK_BIN}/rooted"
  export DEVICE_READY_FILE="${MOCK_BIN}/device-ready"
}

teardown() {
  find "$MOCK_BIN" -depth -type f -exec unlink {} \;
  find "$MOCK_BIN" -depth -type l -exec unlink {} \;
  find "$MOCK_BIN" -depth -type d -exec rmdir {} \;
  export PATH="$ORIGINAL_PATH"
  export HOME="$ORIGINAL_HOME"
}

make_executable() {
  local path="$1"
  local body="$2"
  cat > "${path}" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
${body}
SCRIPT
  chmod +x "${path}"
}

make_mock() {
  make_executable "${MOCK_BIN}/$1" "$2"
}

@test "binds the Android graph session before emitting and polling an SDK navigation event" {
  make_mock adb '
printf "%s\n" "$*" >> "$ADB_LOG"
if [ "$1" = "devices" ]; then
  printf "List of devices attached\nemulator-5554\tdevice\n"
  exit 0
fi
if [ "$*" = "-s emulator-5554 root" ]; then
  touch "$ROOTED_FILE"
  exit 0
fi
if [ "$*" = "-s emulator-5554 wait-for-device" ]; then
  [ -f "$ROOTED_FILE" ] || {
    echo "wait-for-device ran before adb root" >&2
    exit 1
  }
  touch "$DEVICE_READY_FILE"
  exit 0
fi
if [[ "$*" == *"TEST_EMIT_SDK_NAVIGATION"* ]]; then
  if [ ! -f "$SESSION_BOUND_FILE" ]; then
    echo "SDK event emitted before graph session binding" >&2
    exit 1
  fi
  for ((index = 1; index <= $#; index++)); do
    if [ "${!index}" = "destination" ]; then
      next_index=$((index + 1))
      printf "%s\n" "${!next_index}" > "$EVENT_DESTINATION_FILE"
      break
    fi
  done
  touch "$EVENT_TRIGGERED_FILE"
fi
'
  make_mock sleep 'exit 0'
  make_mock jq '
if [ "$1" = "-e" ] && [ "$2" = "--arg" ] && [ "$3" = "destination" ] &&
  grep -Fq -- "$4"; then
  exit 0
fi
exit 1
'
  make_mock auto-mobile '
printf "%s\n" "$*" >> "$AUTO_MOBILE_LOG"
if [ "$1" = "--debug" ] && [ "$2" = "--embedded-sdk" ] && [ "$3" = "--cli" ] && [ "$4" = "--session-uuid" ]; then
  case "$6" in
    launchApp)
      [ -f "$DEVICE_READY_FILE" ] || {
        echo "SDK host launched before rooted device was ready" >&2
        exit 1
      }
      [ "$7" = "--platform" ] && [ "$8" = "android" ] &&
        [ "$9" = "--appId" ] && [ "${10}" = "dev.jasonpearson.automobile.playground" ] &&
        [ "${11}" = "--deviceId" ] && [ "${12}" = "emulator-5554" ]
      exit
      ;;
    observe)
      touch "$SESSION_BOUND_FILE"
      exit
      ;;
    getNavigationGraph)
      [ -f "$EVENT_TRIGGERED_FILE" ] || {
        echo "graph queried before event trigger" >&2
        exit 1
      }
      attempts=0
      [ -f "$GRAPH_ATTEMPTS_FILE" ] && attempts="$(cat "$GRAPH_ATTEMPTS_FILE")"
      attempts=$((attempts + 1))
      printf "%s\n" "$attempts" > "$GRAPH_ATTEMPTS_FILE"
      if [ "$attempts" -eq 1 ]; then
        exit 1
      fi
      destination="$(cat "$EVENT_DESTINATION_FILE")"
      printf "{\"screens\":[{\"name\":\"%s\"}]}\n" "$destination"
      exit 0
      ;;
  esac
fi
echo "unexpected auto-mobile invocation: $*" >&2
exit 1
'

  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "emulator-5554"

  [ "$status" -eq 0 ]
  [ "$(cat "$GRAPH_ATTEMPTS_FILE")" = "2" ]
  [[ "$output" == *"getNavigationGraph attempt 1 failed"* ]]
  grep -Eq -- 'TEST_EMIT_SDK_NAVIGATION.*--es destination Issue5215SdkNavigation-[0-9]+' "$ADB_LOG"
  root_line="$(grep -nFx -- '-s emulator-5554 root' "$ADB_LOG" | cut -d: -f1)"
  wait_for_device_line="$(grep -nFx -- '-s emulator-5554 wait-for-device' "$ADB_LOG" | cut -d: -f1)"
  launch_line="$(grep -n -- "launchApp --platform android --appId dev.jasonpearson.automobile.playground --deviceId emulator-5554" "$AUTO_MOBILE_LOG" | head -n 1 | cut -d: -f1)"
  first_observe_line="$(grep -n -- "observe --platform android --deviceId emulator-5554" "$AUTO_MOBILE_LOG" | head -n 1 | cut -d: -f1)"
  [ "$root_line" -lt "$wait_for_device_line" ]
  [ "$launch_line" -lt "$first_observe_line" ]
}

@test "uses the workspace CLI entrypoint when the global auto-mobile install is unavailable" {
  export GITHUB_WORKSPACE="${MOCK_BIN}/workspace"

  make_mock adb '
if [ "$1" = "devices" ]; then
  printf "List of devices attached\nemulator-5554\tdevice\n"
  exit 0
fi
if [ "$*" = "-s emulator-5554 root" ] || [ "$*" = "-s emulator-5554 wait-for-device" ]; then
  exit 0
fi
if [[ "$*" == *"TEST_EMIT_SDK_NAVIGATION"* ]]; then
  for ((index = 1; index <= $#; index++)); do
    if [ "${!index}" = "destination" ]; then
      next_index=$((index + 1))
      printf "%s\n" "${!next_index}" > "$EVENT_DESTINATION_FILE"
      break
    fi
  done
  touch "$EVENT_TRIGGERED_FILE"
fi
'
  make_mock sleep 'exit 0'
  make_mock jq '
if [ "$1" = "-e" ] && [ "$2" = "--arg" ] && [ "$3" = "destination" ] &&
  grep -Fq -- "$4"; then
  exit 0
fi
exit 1
'
  mkdir -p "${GITHUB_WORKSPACE}/dist/src"
  mkdir -p "${HOME}/.bun/bin"
  ln -s "${HOME}/.bun/bin/missing-auto-mobile" "${HOME}/.bun/bin/auto-mobile"
  make_executable "${GITHUB_WORKSPACE}/dist/src/index.js" '
printf "%s\n" "$*" >> "$AUTO_MOBILE_LOG"
case "$6" in
  launchApp)
    exit 0
    ;;
  observe)
    exit 0
    ;;
  getNavigationGraph)
    [ -f "$EVENT_TRIGGERED_FILE" ]
    destination="$(cat "$EVENT_DESTINATION_FILE")"
    printf "{\"screens\":[{\"name\":\"%s\"}]}\n" "$destination"
    exit 0
    ;;
esac
exit 1
'

  run env PATH="${MOCK_BIN}:/bin:/usr/bin" GITHUB_WORKSPACE="$GITHUB_WORKSPACE" HOME="$HOME" bash "$SCRIPT" "emulator-5554"

  [ "$status" -eq 0 ]
  [ -L "${HOME}/.bun/bin/auto-mobile" ]
  [ "$(readlink "${HOME}/.bun/bin/auto-mobile")" = "${GITHUB_WORKSPACE}/dist/src/index.js" ]
  [[ "$output" == *"linking ${HOME}/.bun/bin/auto-mobile -> ${GITHUB_WORKSPACE}/dist/src/index.js"* ]]
  grep -q -- 'getNavigationGraph --platform android --deviceId emulator-5554' "$AUTO_MOBILE_LOG"
}
