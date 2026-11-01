#!/usr/bin/env bats

SCRIPT="scripts/android/keystore-fixture-integration.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  export ADB_LOG="${MOCK_BIN}/adb.log"
  export FIXTURE_JSON='{"schemaVersion":1,"capability":"storage.keystore","outcome":"ok","bridgeAvailable":true,"metadata":"supported","mutation":"declared_unsupported","scopes":["fixture"],"deviceLocked":"unlocked","entries":[{"alias":"automobile.fixture","present":true,"category":"KEY"},{"alias":"automobile.fixture.certificate","present":true,"category":"CERTIFICATE"}]}'
  export DELETE_JSON='{"schemaVersion":1,"capability":"storage.keystore","bridgeAvailable":true,"requestedScope":"fixture","deletedCount":2,"outcome":"ok","status":"deleted","aliases":[{"alias":"automobile.fixture","outcome":"deleted"},{"alias":"automobile.fixture.certificate","outcome":"deleted"}]}'
  export EMPTY_DELETE_JSON='{"schemaVersion":1,"capability":"storage.keystore","bridgeAvailable":true,"deletedCount":0,"outcome":"invalid_selector","reason":"EMPTY_SELECTOR"}'
  export FIXTURE_STATE="${MOCK_BIN}/state"
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
    echo present > "$FIXTURE_STATE"
    printf 'Broadcast completed: result=%s\n' "${SEED_RESULT:--1}" ;;
  'shell content call --uri content://dev.jasonpearson.automobile.playground.automobile.keystore --method metadata --extra scope:s:fixture')
    metadata="$FIXTURE_JSON"
    if [[ "$(cat "$FIXTURE_STATE")" == absent ]]; then
      metadata="$(jq '.entries |= map(.present = false | .category = "UNKNOWN")' <<< "$metadata")"
      if [[ -n "${ABSENT_FILTER:-}" ]]; then
        metadata="$(jq "$ABSENT_FILTER" <<< "$metadata")"
      fi
    fi
    printf 'Result: Bundle[{result=%s}]\n' "$metadata" ;;
  'shell content call --uri content://dev.jasonpearson.automobile.playground.automobile.keystore --method delete --extra scope:s:fixture')
    echo absent > "$FIXTURE_STATE"
    printf 'Result: Bundle[{result=%s}]\n' "$DELETE_JSON" ;;
  'shell content call --uri content://dev.jasonpearson.automobile.playground.automobile.keystore --method delete')
    if [[ "${EMPTY_DELETE_MUTATES:-0}" == 1 ]]; then
      echo absent > "$FIXTURE_STATE"
    fi
    printf 'Result: Bundle[{result=%s}]\n' "$EMPTY_DELETE_JSON" ;;
  *) exit 92 ;;
esac
MOCK
  chmod +x "${MOCK_BIN}/adb"
  export ADB_BIN="${MOCK_BIN}/adb"
}

teardown() {
  rm -rf "$MOCK_BIN"
}

@test "verifies scoped deletion and empty-selector preservation with the selected device" {
  run bash "$SCRIPT" emulator-5554
  [ "$status" -eq 0 ]
  [[ "$output" == *"metadata verified"* ]]
  [ "$(sed -n '1p' "$ADB_LOG")" = '-s emulator-5554 root' ]
  [ "$(sed -n '2p' "$ADB_LOG")" = '-s emulator-5554 wait-for-device' ]
  [[ "$(sed -n '3p' "$ADB_LOG")" == *'am start -W'* ]]
  [[ "$(sed -n '4p' "$ADB_LOG")" == *'TEST_SEED_KEYSTORE_FIXTURE -p dev.jasonpearson.automobile.playground' ]]
  [[ "$(sed -n '5p' "$ADB_LOG")" == *'--method metadata --extra scope:s:fixture' ]]
  [[ "$(sed -n '6p' "$ADB_LOG")" == *'--method delete --extra scope:s:fixture' ]]
  [[ "$(sed -n '7p' "$ADB_LOG")" == *'--method metadata --extra scope:s:fixture' ]]
  [[ "$(sed -n '8p' "$ADB_LOG")" == *'TEST_SEED_KEYSTORE_FIXTURE -p dev.jasonpearson.automobile.playground' ]]
  [[ "$(sed -n '9p' "$ADB_LOG")" == *'--method metadata --extra scope:s:fixture' ]]
  [[ "$(sed -n '10p' "$ADB_LOG")" == *'--method delete' ]]
  [[ "$(sed -n '11p' "$ADB_LOG")" == *'--method metadata --extra scope:s:fixture' ]]
  [[ "$output" == *'scoped deletion verified'* ]]
  [[ "$output" == *'empty-selector rejection verified'* ]]
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

@test "rejects incorrect deletion results and undocumented fields" {
  local original="$DELETE_JSON"
  for filter in '.outcome = "authorization_denied"' '.status = "partial"' '.deletedCount = 1' \
    '.requestedScope = "other"' '.aliases[0].outcome = "failed"' '.aliases[1].outcome = "not_found"' \
    '.aliases = []' '.aliases[0].alias = "unrelated"' \
    '.keyMaterial = "secret"' '.aliases[0].keyMaterial = "secret"'; do
    export DELETE_JSON="$(jq "$filter" <<< "$original")"
    run bash "$SCRIPT" emulator-5554
    [ "$status" -eq 1 ]
    [[ "$output" == *'deletion must report'* ]]
  done
}

@test "rejects metadata that does not confirm both aliases absent" {
  for filter in '.entries[0].present = true' '.entries[1].present = true' '.entries = []'; do
    export ABSENT_FILTER="$filter"
    run bash "$SCRIPT" emulator-5554
    [ "$status" -eq 1 ]
    [[ "$output" == *'must be absent after deletion'* ]]
  done
}

@test "rejects empty-selector results that permit deletion or expose extra fields" {
  local original="$EMPTY_DELETE_JSON"
  for filter in '.outcome = "ok"' '.deletedCount = 1' '.reason = "OTHER"' '.keyMaterial = "secret"'; do
    export EMPTY_DELETE_JSON="$(jq "$filter" <<< "$original")"
    run bash "$SCRIPT" emulator-5554
    [ "$status" -eq 1 ]
    [[ "$output" == *'must be rejected without deleting anything'* ]]
  done
}

@test "rejects empty-selector deletion that removes seeded entries despite reporting zero" {
  export EMPTY_DELETE_MUTATES=1
  run bash "$SCRIPT" emulator-5554
  [ "$status" -eq 1 ]
  [[ "$output" == *'metadata must contain only the two present'* ]]
}
