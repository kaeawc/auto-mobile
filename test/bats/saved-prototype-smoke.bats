#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  export TEST_DIR="$(mktemp -d)"
  export CALLS="$TEST_DIR/calls"
  : > "$CALLS"
  cat > "$TEST_DIR/cli" <<'EOF'
#!/usr/bin/env bash
printf 'cli %s\n' "$*" >> "$CALLS"
case "${CLI_MODE:-happy}:$*" in
  *'getAndroid'*) printf '{"runtime":{"session":{"sessionUuid":"acquired-session"}}}\n';;
  unsupported:*) printf '{"success":false,"errorCode":"unsupported_capability"}\n'; exit 1;;
  invalid:*) echo 'Error: invalid action listSaved'; exit 2;;
  platform:*) printf '{"success":false,"errorCode":"unsupported_platform"}\n'; exit 1;;
  other:*) printf '{"success":false,"errorCode":"internal"}\n'; exit 1;;
  noisy:*'--action listSaved'*) if [[ -f "$TEST_DIR/saved" ]]; then echo '{"success":true,"savedPrototypes":[{"id":"smoke-saved-12269"}]}'; else echo '{"success":true,"savedPrototypes":[]}'; fi; echo 'diagnostic: not JSON' >&2;;
  delete-false:*'--action deleteSaved'*) echo '{"success":false,"errorCode":"internal"}'; exit 1;;
  pinned:*'--action save'*'--pin true'*) echo '{"success":true,"pinned":"pinned"}';;
  *'--action listSaved'*) if [[ -f "$TEST_DIR/saved" ]]; then echo '{"success":true,"savedPrototypes":[{"id":"smoke-saved-12269"}]}'; else echo '{"success":true,"savedPrototypes":[]}'; fi;;
  *'--action save'*'--pin true'*) if [[ "${CLI_MODE:-happy}" == pinned ]]; then echo '{"success":true,"pinned":"pinned"}'; else echo '{"success":true,"pinned":"unsupported"}'; fi;;
  *'--action save'*) touch "$TEST_DIR/saved"; echo '{"success":true,"saved":{"id":"smoke-saved-12269"}}';;
  *'--action deleteSaved'*) if [[ "$*" == *'--id smoke-saved-12269'* ]]; then rm -f "$TEST_DIR/saved"; fi; echo '{"success":true}';;
esac
EOF
  chmod +x "$TEST_DIR/cli"
  cat > "$TEST_DIR/adb" <<'EOF'
#!/usr/bin/env bash
printf 'adb %s\n' "$*" >> "$CALLS"
case "$*" in
  devices) echo 'List of devices attached'; echo 'emulator-5554 device';;
  *' root') [[ "${ROOT_FAIL:-0}" == 0 ]] || exit 1;;
  *' am start '*) [[ "${AM_START_FAIL:-0}" == 0 ]] || exit 1;;
  *' dumpsys activity activities') [[ "${ACTIVITY_MISSING:-0}" == 1 ]] || echo 'mResumedActivity SavedPrototypeActivity';;
esac
EOF
  chmod +x "$TEST_DIR/adb"
}

teardown() { rm -rf "$TEST_DIR"; }

run_smoke() {
  run env ADB_BIN="$TEST_DIR/adb" AUTO_MOBILE_CMD="$TEST_DIR/cli" SMOKE_SESSION_UUID=test-session SMOKE_POLL_SLEEP=0 "$@" bash "$ROOT/scripts/android/saved-prototype-smoke.sh" emulator-5554
}

@test "unsupported capability skips before saving or launching" {
  run_smoke CLI_MODE=unsupported
  [ "$status" -eq 0 ]
  [[ "$output" == 'skipped: capability prototype_saved_v1 not advertised' ]]
  [[ "$(cat "$CALLS")" != *'--action save'* ]]
  [[ "$(cat "$CALLS")" != *' am start '* ]]
}

@test "unsupported platform skips cleanly" {
  run_smoke CLI_MODE=platform
  [ "$status" -eq 0 ]
  [[ "$output" == 'skipped: saved prototypes are not supported on this platform' ]]
}

@test "other list failure is an error" {
  run_smoke CLI_MODE=other
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: listSaved:'* ]]
}

@test "CLI stderr diagnostics do not corrupt parsed JSON" {
  run_smoke CLI_MODE=noisy
  [ "$status" -eq 0 ]
  [[ "$output" == *'ok: deleteSaved'* ]]
}

@test "invalid action text skips in its own capability branch" {
  run_smoke CLI_MODE=invalid
  [ "$status" -eq 0 ]
  [[ "$output" == *'skipped: capability prototype_saved_v1 not advertised'* ]]
}

@test "happy path saves lists launches and deletes" {
  run_smoke
  [ "$status" -eq 0 ]
  [[ "$output" == *'ok: save'*'ok: listSaved'*'skipped: pin step: pinning not available in this build'*'ok: launch'*'ok: deleteSaved'* ]]
}

@test "pin reports a supported pinned result" {
  run_smoke CLI_MODE=pinned
  [ "$status" -eq 0 ]
  [[ "$output" == *'ok: pin (pinned=pinned)'* ]]
}

@test "deleteSaved success false is a failure" {
  run_smoke CLI_MODE=delete-false
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: deleteSaved:'* ]]
}

@test "am start failure fails launch" {
  run_smoke AM_START_FAIL=1
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: launch: activity start failed'* ]]
}

@test "missing activity fails and cleanup deletes saved entry" {
  run_smoke ACTIVITY_MISSING=1
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: launch:'* ]]
  [ "$(grep -c -- '--action deleteSaved' "$CALLS")" -ge 2 ]
}

@test "adb root failure skips launch and continues" {
  run_smoke ROOT_FAIL=1
  [ "$status" -eq 0 ]
  [[ "$output" == *'skipped: launch step: adb root unavailable (SavedPrototypeActivity is not exported)'* ]]
  [[ "$output" == *'ok: deleteSaved'* ]]
}

@test "a supplied session UUID is not released" {
  run_smoke
  [ "$status" -eq 0 ]
  [[ "$(cat "$CALLS")" != *'release-session'* ]]
}

@test "an acquired session is released exactly once" {
  mkdir -p "$TEST_DIR/bin"
  cat > "$TEST_DIR/bin/auto-mobile" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == '--daemon release-session '* ]]; then
  printf 'release %s\n' "$*" >> "$CALLS"
else
  exec "$TEST_DIR/cli" "$@"
fi
EOF
  chmod +x "$TEST_DIR/bin/auto-mobile"
  run env PATH="$TEST_DIR/bin:$PATH" ADB_BIN="$TEST_DIR/adb" AUTO_MOBILE_CMD="$TEST_DIR/bin/auto-mobile --debug --embedded-sdk --cli" SMOKE_POLL_SLEEP=0 CLI_MODE=happy bash "$ROOT/scripts/android/saved-prototype-smoke.sh" emulator-5554
  [ "$status" -eq 0 ]
  [ "$(grep -c '^release --daemon release-session acquired-session$' "$CALLS")" -eq 1 ]
  [ "$(grep -n 'adb -s emulator-5554 root' "$CALLS" | cut -d: -f1)" -lt "$(grep -n '^cli .*getAndroid' "$CALLS" | cut -d: -f1)" ]
}
