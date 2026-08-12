#!/usr/bin/env bats

SCRIPT="scripts/android/verify-sdk-ctrl-proxy-permission-contract.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIGINAL_PATH="$PATH"
  COMMAND_LOG="${MOCK_BIN}/commands"
  CTRL_PROXY_APK="${MOCK_BIN}/control-proxy.apk"
  HOST_APK="$(pwd)/android/playground/app/build/outputs/apk/debug/app-debug.apk"
  LEGACY_HOST_APK="$(pwd)/android/playground/app/build/outputs/apk/debug/playground-app-debug.apk"
  touch "$CTRL_PROXY_APK"
  unlink "$LEGACY_HOST_APK" 2>/dev/null || true
}

teardown() {
  find "$MOCK_BIN" -type f -exec unlink {} \;
  rmdir "$MOCK_BIN"
  export PATH="$ORIGINAL_PATH"
}

make_mock() {
  local name="$1"
  local body="$2"
  cat > "${MOCK_BIN}/${name}" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
${body}
SCRIPT
  chmod +x "${MOCK_BIN}/${name}"
}

@test "co-installs a separately signed SDK host in both orders and verifies a V2 control broadcast" {
  make_mock keytool '
for ((index = 1; index <= $#; index++)); do
  if [[ "${!index}" == "-keystore" ]]; then
    next=$((index + 1))
    touch "${!next}"
  fi
done
'
  make_mock gradlew '
printf "gradlew RELEASE_KEYSTORE_PATH=%s %s\n" "${RELEASE_KEYSTORE_PATH:-}" "$*" >> "$COMMAND_LOG"
mkdir -p playground/app/build/outputs/apk/debug
touch playground/app/build/outputs/apk/debug/app-debug.apk
'
  make_mock apksigner '
apk="${!#}"
if [[ "$apk" == *control-proxy.apk ]]; then
  printf "Signer #1 certificate SHA-256 digest: ctrl-proxy\n"
else
  printf "Signer #1 certificate SHA-256 digest: sdk-host\n"
fi
'
  make_mock adb '
printf "adb %s\n" "$*" >> "$COMMAND_LOG"
if [[ "$*" == *"run-as dev.jasonpearson.automobile.playground cat files/automobile-network-control-contract-result"* ]]; then
  printf "ctrlproxy-v2\n"
fi
'

  run env \
    ADB_BIN="${MOCK_BIN}/adb" \
    APKSIGNER_BIN="${MOCK_BIN}/apksigner" \
    GRADLE_CMD="${MOCK_BIN}/gradlew" \
    KEYTOOL_BIN="${MOCK_BIN}/keytool" \
    COMMAND_LOG="$COMMAND_LOG" \
    bash "$SCRIPT" "$CTRL_PROXY_APK"

  [ "$status" -eq 0 ]
  [[ "$output" == *"verified V2 control broadcast delivery"* ]]
  grep -Eq '^gradlew RELEASE_KEYSTORE_PATH=.+ :playground:app:assembleDebug --console=plain$' \
    "$COMMAND_LOG"
  send_command='adb shell am broadcast -a dev.jasonpearson.automobile.ctrlproxy.action.TEST_SEND_NETWORK_CONTROL -p dev.jasonpearson.automobile.ctrlproxy'
  [ "$(grep -cFx "$send_command" "$COMMAND_LOG")" -eq 2 ]

  host_first="$(grep -n "adb install ${HOST_APK}" "$COMMAND_LOG" | head -n 1 | cut -d: -f1)"
  proxy_after_host="$(grep -n "adb install ${CTRL_PROXY_APK}" "$COMMAND_LOG" | head -n 1 | cut -d: -f1)"
  proxy_first="$(grep -n "adb install ${CTRL_PROXY_APK}" "$COMMAND_LOG" | tail -n 1 | cut -d: -f1)"
  host_after_proxy="$(grep -n "adb install ${HOST_APK}" "$COMMAND_LOG" | tail -n 1 | cut -d: -f1)"
  first_send="$(grep -nF "$send_command" "$COMMAND_LOG" | head -n 1 | cut -d: -f1)"
  second_send="$(grep -nF "$send_command" "$COMMAND_LOG" | tail -n 1 | cut -d: -f1)"

  [ "$host_first" -lt "$proxy_after_host" ]
  [ "$proxy_after_host" -lt "$first_send" ]
  [ "$first_send" -lt "$proxy_first" ]
  [ "$proxy_first" -lt "$host_after_proxy" ]
  [ "$host_after_proxy" -lt "$second_send" ]
}

@test "retries the V2 control broadcast until the SDK host receiver is ready" {
  make_mock keytool '
for ((index = 1; index <= $#; index++)); do
  if [[ "${!index}" == "-keystore" ]]; then
    next=$((index + 1))
    touch "${!next}"
  fi
done
'
  make_mock gradlew '
mkdir -p playground/app/build/outputs/apk/debug
touch playground/app/build/outputs/apk/debug/app-debug.apk
'
  make_mock apksigner '
apk="${!#}"
if [[ "$apk" == *control-proxy.apk ]]; then
  printf "Signer #1 certificate SHA-256 digest: ctrl-proxy\n"
else
  printf "Signer #1 certificate SHA-256 digest: sdk-host\n"
fi
'
  make_mock adb '
printf "adb %s\n" "$*" >> "$COMMAND_LOG"
if [[ "$*" == *"run-as dev.jasonpearson.automobile.playground cat files/automobile-network-control-contract-result"* ]]; then
  send_command="adb shell am broadcast -a dev.jasonpearson.automobile.ctrlproxy.action.TEST_SEND_NETWORK_CONTROL -p dev.jasonpearson.automobile.ctrlproxy"
  if [[ "$(grep -cFx "$send_command" "$COMMAND_LOG")" -ge 2 ]]; then
    printf "ctrlproxy-v2\n"
  fi
fi
'
  make_mock sleep ':'

  run env \
    ADB_BIN="${MOCK_BIN}/adb" \
    APKSIGNER_BIN="${MOCK_BIN}/apksigner" \
    GRADLE_CMD="${MOCK_BIN}/gradlew" \
    KEYTOOL_BIN="${MOCK_BIN}/keytool" \
    SLEEP_BIN="${MOCK_BIN}/sleep" \
    COMMAND_LOG="$COMMAND_LOG" \
    bash "$SCRIPT" "$CTRL_PROXY_APK"

  [ "$status" -eq 0 ]
  send_command='adb shell am broadcast -a dev.jasonpearson.automobile.ctrlproxy.action.TEST_SEND_NETWORK_CONTROL -p dev.jasonpearson.automobile.ctrlproxy'
  [ "$(grep -cFx "$send_command" "$COMMAND_LOG")" -ge 3 ]
}
