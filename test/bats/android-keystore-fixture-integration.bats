#!/usr/bin/env bats

SCRIPT="scripts/android/keystore-fixture-integration.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  export ADB_LOG="${MOCK_BIN}/adb.log"
  export FIXTURE_JSON='{"schemaVersion":1,"capability":"storage.keystore","outcome":"ok","bridgeAvailable":true,"metadata":"supported","mutation":"declared_unsupported","scopes":["fixture"],"deviceLocked":"unlocked","entries":[{"alias":"automobile.fixture","present":true,"category":"KEY"},{"alias":"automobile.fixture.certificate","present":true,"category":"CERTIFICATE"}]}'
  cat > "${MOCK_BIN}/adb" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$ADB_LOG"
if [[ "$*" == devices ]]; then
  printf 'List of devices attached\nemulator-5554\tdevice\n'
  exit 0
fi
[[ "$1" == -s && "$2" == emulator-5554 ]] || exit 91
case "${*:3}" in
  root|wait-for-device) ;;
  'shell am start -W -n dev.jasonpearson.automobile.playground/.MainActivity') ;;
  'shell am broadcast -a dev.jasonpearson.automobile.playground.action.TEST_SEED_KEYSTORE_FIXTURE -p dev.jasonpearson.automobile.playground')
    printf 'Broadcast completed: result=%s\n' "${SEED_RESULT:--1}" ;;
  'shell content call --uri content://dev.jasonpearson.automobile.playground.automobile.keystore --method metadata --extra scope:s:fixture')
    printf 'Result: Bundle[{result=%s}]\n' "$FIXTURE_JSON" ;;
  *) exit 92 ;;
esac
MOCK
  chmod +x "${MOCK_BIN}/adb"
  export ADB_BIN="${MOCK_BIN}/adb"
}

teardown() {
  rm -rf "$MOCK_BIN"
}

@test "roots and launches before seeding and querying metadata with the selected device" {
  run bash "$SCRIPT" emulator-5554
  [ "$status" -eq 0 ]
  [[ "$output" == *"metadata verified"* ]]
  [ "$(sed -n '1p' "$ADB_LOG")" = '-s emulator-5554 root' ]
  [ "$(sed -n '2p' "$ADB_LOG")" = '-s emulator-5554 wait-for-device' ]
  [[ "$(sed -n '3p' "$ADB_LOG")" == *'am start -W'* ]]
  [[ "$(sed -n '4p' "$ADB_LOG")" == *'TEST_SEED_KEYSTORE_FIXTURE -p dev.jasonpearson.automobile.playground' ]]
  [[ "$(sed -n '5p' "$ADB_LOG")" == *'--method metadata --extra scope:s:fixture' ]]
}

@test "discovers the device when omitted" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(sed -n '1p' "$ADB_LOG")" = devices ]
}

@test "rejects missing entries and incorrect categories" {
  local original="$FIXTURE_JSON"
  for filter in '.entries[0].present = false' '.entries[1].category = "UNKNOWN"' '.entries = []'; do
    FIXTURE_JSON="$(jq "$filter" <<< "$original")"
    export FIXTURE_JSON
    run bash "$SCRIPT" emulator-5554
    [ "$status" -eq 1 ]
  done
}

@test "rejects material fields on entries and the envelope" {
  for filter in '.entries[0].keyMaterial = "secret"' '.certificate = "bytes"'; do
    local original="$FIXTURE_JSON"
    FIXTURE_JSON="$(jq "$filter" <<< "$original")"
    export FIXTURE_JSON
    run bash "$SCRIPT" emulator-5554
    [ "$status" -eq 1 ]
    FIXTURE_JSON="$original"
  done
}

@test "seed failure stops before metadata query" {
  export SEED_RESULT=0
  run bash "$SCRIPT" emulator-5554
  [ "$status" -eq 1 ]
  [[ "$output" == *'seeding failed'* ]]
  ! grep -q 'content call' "$ADB_LOG"
}
