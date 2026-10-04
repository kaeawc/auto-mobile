#!/usr/bin/env bats

SCRIPT="scripts/android/run-emulator-tests.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIGINAL_PATH="$PATH"
  export ATTEMPTS_FILE="${MOCK_BIN}/attempts"
  export TMPDIR="${MOCK_BIN}"
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIGINAL_PATH"
}

make_mock() {
  local name="$1"
  local body="$2"
  cat > "${MOCK_BIN}/${name}" <<MOCK
#!/usr/bin/env bash
set -euo pipefail
${body}
MOCK
  chmod +x "${MOCK_BIN}/${name}"
}

make_common_mocks() {
  make_mock adb '
if [ "$1" = "--version" ]; then echo "Android Debug Bridge version 1.0.41"; exit 0; fi
if [ "$1" = "devices" ]; then printf "List of devices attached\n"; exit 0; fi
exit 0
'
  make_mock sleep 'exit 0'
}

make_test_script() {
  local body="$1"
  cat > "${MOCK_BIN}/test-script" <<SCRIPT_BODY
#!/usr/bin/env bash
set -euo pipefail
${body}
SCRIPT_BODY
  chmod +x "${MOCK_BIN}/test-script"
}

@test "prints the first transient attempt error when a later attempt fails" {
  make_common_mocks
  make_test_script '
attempt=0
[ -f "$ATTEMPTS_FILE" ] && attempt="$(cat "$ATTEMPTS_FILE")"
attempt=$((attempt + 1))
printf "%s\n" "$attempt" > "$ATTEMPTS_FILE"
if [ "$attempt" -eq 1 ]; then echo "device offline: first diagnostic"; else echo "device offline: second diagnostic"; fi
exit 17
'

  run env PATH="${MOCK_BIN}:${PATH}" RETRY_MAX_ATTEMPTS=2 RETRY_INITIAL_DELAY=0 \
    bash "$SCRIPT" "" "${MOCK_BIN}/test-script"

  [ "$status" -eq 17 ]
  [ "$(cat "$ATTEMPTS_FILE")" -eq 2 ]
  [[ "$output" == *"First attempt error:"*"device offline: first diagnostic"* ]]
  [[ "$output" == *"device offline: second diagnostic"* ]]
}

@test "success on the first attempt is unchanged" {
  make_common_mocks
  make_test_script '
echo "first attempt passed"
'

  run env PATH="${MOCK_BIN}:${PATH}" RETRY_MAX_ATTEMPTS=2 RETRY_INITIAL_DELAY=0 \
    bash "$SCRIPT" "" "${MOCK_BIN}/test-script"

  [ "$status" -eq 0 ]
  [[ "$output" == *"first attempt passed"* ]]
  [ ! -f "$ATTEMPTS_FILE" ]
  [[ "$output" != *"First attempt error:"* ]]
}

@test "non-transient failures still do not retry" {
  make_common_mocks
  make_test_script '
attempt=0
[ -f "$ATTEMPTS_FILE" ] && attempt="$(cat "$ATTEMPTS_FILE")"
attempt=$((attempt + 1))
printf "%s\n" "$attempt" > "$ATTEMPTS_FILE"
echo "assertion failed: expected value"
exit 19
'

  run env PATH="${MOCK_BIN}:${PATH}" RETRY_MAX_ATTEMPTS=3 RETRY_INITIAL_DELAY=0 \
    bash "$SCRIPT" "" "${MOCK_BIN}/test-script"

  [ "$status" -eq 19 ]
  [ "$(cat "$ATTEMPTS_FILE")" -eq 1 ]
  [[ "$output" == *"Command failed with non-transient error"* ]]
  [[ "$output" != *"First attempt error:"* ]]
}

@test "shows the first transient error when a retry ends in a non-transient failure" {
  make_common_mocks
  make_test_script '
attempt=0
[ -f "$ATTEMPTS_FILE" ] && attempt="$(cat "$ATTEMPTS_FILE")"
attempt=$((attempt + 1))
printf "%s\n" "$attempt" > "$ATTEMPTS_FILE"
if [ "$attempt" -eq 1 ]; then
  echo "device offline: first retryable diagnostic"
else
  echo "assertion failed: later test failure"
fi
exit 21
'

  run env PATH="${MOCK_BIN}:${PATH}" RETRY_MAX_ATTEMPTS=3 RETRY_INITIAL_DELAY=0 \
    bash "$SCRIPT" "" "${MOCK_BIN}/test-script"

  [ "$status" -eq 21 ]
  [ "$(cat "$ATTEMPTS_FILE")" -eq 2 ]
  [[ "$output" == *"Command failed with non-transient error"* ]]
  [[ "$output" == *"First attempt error:"*"device offline: first retryable diagnostic"* ]]
}

@test "retry helper recognizes a transient error before a large command log" {
  make_test_script '
attempt=0
[ -f "$ATTEMPTS_FILE" ] && attempt="$(cat "$ATTEMPTS_FILE")"
attempt=$((attempt + 1))
printf "%s\n" "$attempt" > "$ATTEMPTS_FILE"
if [ "$attempt" -eq 1 ]; then
  echo "device offline"
  awk '\''BEGIN { for (i=0; i<20000; i++) print "command log filler" }'\''
  exit 17
fi
'
  awk '/^retry_with_backoff\(\)/ { copy=1 } copy { print } copy && /^}/ { exit }' "$SCRIPT" > "$MOCK_BIN/retry-helper.sh"
  run env PATH="$MOCK_BIN:$PATH" bash -euo pipefail -c '
    source "$1"
    print_success() { :; }; print_warning() { :; }; print_error() { :; }
    sleep() { :; }
    BLUE=""; NC=""; RETRY_MAX_ATTEMPTS=2; RETRY_INITIAL_DELAY=0
    retry_log_dir="$2"
    retry_with_backoff "$2/test-script"
  ' _ "$MOCK_BIN/retry-helper.sh" "$MOCK_BIN"
  [ "$status" -eq 0 ]
  [ "$(cat "$ATTEMPTS_FILE")" -eq 2 ]
}
