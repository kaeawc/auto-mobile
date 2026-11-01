#!/usr/bin/env bats
# All device and CLI operations are stubbed; no simulator or daemon is touched.

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  export TEST_DIR="$BATS_TEST_TMPDIR/smoke"
  mkdir -p "$TEST_DIR/bin" "$TEST_DIR/DeepLinkDemo.app"
  export CALLS="$TEST_DIR/calls"
  : > "$CALLS"
  # The checked-in bundle is metadata only. plutil accepts its JSON plist;
  # stage it under the installed bundle's filename, keeping the fixture intact.
  cp "$ROOT/test/fixtures/ios-app-bundle/DeepLinkDemo.app/Info.plist.json" "$TEST_DIR/DeepLinkDemo.app/Info.plist"
  # Exercise Apple's real plist reader on macOS; stub that OS boundary elsewhere
  # so this device-free BATS suite also runs in the Linux shell lane.
  if [[ "$OSTYPE" != darwin* ]]; then
    cat > "$TEST_DIR/bin/plutil" <<'STUB'
#!/usr/bin/env bash
[[ "$1 $2 $3 $4 $5" == '-extract CFBundleIdentifier raw -o -' ]] || exit 2
jq -er '.CFBundleIdentifier' "$6"
STUB
    chmod +x "$TEST_DIR/bin/plutil"
  fi
  export PROTOTYPE_SMOKE_APP_BUNDLE="$TEST_DIR/DeepLinkDemo.app"
  export XCRUN_BIN="$TEST_DIR/bin/xcrun"
  export AUTO_MOBILE_CMD="$TEST_DIR/bin/auto-mobile --debug --embedded-sdk --cli"
  export PATH="$TEST_DIR/bin:$PATH"
  unset SMOKE_SESSION_UUID
  cat > "$XCRUN_BIN" <<'STUB'
#!/usr/bin/env bash
printf 'xcrun %s\n' "$*" >> "$CALLS"
[[ "$*" == "simctl install test-udid $PROTOTYPE_SMOKE_APP_BUNDLE" ]]
STUB
  cat > "$TEST_DIR/bin/auto-mobile" <<'STUB'
#!/usr/bin/env bash
printf 'cli %s\n' "$*" >> "$CALLS"
if [[ "$1" == --daemon ]]; then
  [[ "$*" == '--daemon release-session smoke-session' ]] || exit 1
  [[ "${MODE:-}" != release-fails ]] || exit 1
  touch "$TEST_DIR/released"
  exit 0
fi
[[ "$1 $2 $3" == '--debug --embedded-sdk --cli' ]] || exit 2
shift 3
if [[ "$1" == getApple ]]; then
  [[ "$*" == 'getApple --deviceId test-udid' ]] || exit 2
  echo '{"runtime":{"session":{"sessionUuid":"smoke-session"}}}'
  exit 0
fi
if [[ -f "$TEST_DIR/released" ]]; then
  [[ "$*" == 'prototype --deviceId test-udid --action status' ]] || exit 2
else
  [[ "$1 $2" == '--session-uuid smoke-session' ]] || exit 2
  shift 2
fi
tool="$1"; shift
[[ "$1 $2" == '--deviceId test-udid' ]] || exit 2
shift 2
case "$tool:$*" in
  'launchApp:--platform ios --appId com.example.deeplinkdemo --prototype true') echo '{"success":true}';;
  'prototype:--action show --spec '*)
    [[ "${MODE:-}" != unsupported ]] || { echo '{"success":false,"errorCode":"unsupported_capability"}'; exit 1; }
    [[ "${MODE:-}" != platform ]] || { echo '{"success":false,"errorCode":"unsupported_platform"}'; exit 1; }
    [[ "${MODE:-}" != show-fails ]] || { echo '{"success":false,"error":"show refused"}'; exit 1; }
    [[ ! -f "$TEST_DIR/released" ]] || exit 1
    touch "$TEST_DIR/shown"
    echo '{"content":[{"type":"text","text":"{\"success\":true}"}]}';;
  'tapOn:--selector {"text":"MCP smoke tap"}') touch "$TEST_DIR/tapped"; echo '{"success":true}';;
  'prototype:--action awaitEvent --id mcp-smoke --eventName smoke-tapped --timeoutMs 5000')
    [[ -f "$TEST_DIR/tapped" ]] || exit 1
    [[ "${MODE:-}" != await-fails ]] || { echo '{"success":true,"timedOut":true}'; exit 0; }
    if [[ "${MODE:-}" == wrong-event ]]; then id=wrong; else id=mcp-smoke; fi
    printf '{"success":true,"event":{"id":"%s","name":"smoke-tapped"}}\n' "$id";;
  'prototype:--action status')
    [[ "${MODE:-}" != malformed-status ]] || { echo '{"success":true}'; exit 0; }
    if [[ -f "$TEST_DIR/shown" || "${MODE:-}" == stuck ]]; then echo '{"success":true,"prototypes":[{"id":"mcp-smoke"}]}'; else echo '{"success":true,"prototypes":[]}'; fi;;
  'prototype:--action dismiss --id mcp-smoke') rm -f "$TEST_DIR/shown"; echo '{"success":true}';;
  *) echo "unexpected CLI args: $tool $*" >&2; exit 2;;
esac
STUB
  chmod +x "$XCRUN_BIN" "$TEST_DIR/bin/auto-mobile"
}

run_smoke() { run bash "$ROOT/scripts/ios/prototype-mcp-smoke.sh" test-udid; }

@test "usage exits 2 without touching a device" {
  run bash "$ROOT/scripts/ios/prototype-mcp-smoke.sh"
  [ "$status" -eq 2 ]
  [[ "$output" == *'usage:'* ]]
  [ ! -s "$CALLS" ]
}

@test "full MCP path reads the fixture bundle id and releases once before final status" {
  run_smoke
  [ "$status" -eq 0 ]
  [[ "$output" == *'ok: getApple'*'ok: install'*'ok: launchApp'*'ok: show'*'ok: tapOn'*'ok: awaitEvent'*'ok: status shown'*'ok: dismiss'*'ok: status dismissed'*'ok: release session'*'ok: status released'* ]]
  [ "$(grep -c -- '--daemon release-session smoke-session' "$CALLS")" -eq 1 ]
  [[ "$(tail -2 "$CALLS")" == *'release-session smoke-session'*'--action status' ]]
  [ "$(grep -c '^xcrun ' "$CALLS")" -eq 1 ]
  grep -q -- '--appId com.example.deeplinkdemo --prototype true' "$CALLS"
}

@test "show failure exits 1 and releases" {
  export MODE=show-fails
  run_smoke
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: show:'* ]]
  [ -f "$TEST_DIR/released" ]
}

@test "awaitEvent timeout exits 1" {
  export MODE=await-fails
  run_smoke
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: awaitEvent:'* ]]
  [ -f "$TEST_DIR/released" ]
}

@test "awaitEvent must return the matching event id" {
  export MODE=wrong-event
  run_smoke
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: awaitEvent:'* ]]
}

@test "unsupported capability exits 3 with a reason and releases" {
  export MODE=unsupported
  run_smoke
  [ "$status" -eq 3 ]
  [[ "$output" == *'skipped: show: unsupported_capability'* ]]
  [ -f "$TEST_DIR/released" ]
}

@test "unsupported platform exits 3" {
  export MODE=platform
  run_smoke
  [ "$status" -eq 3 ]
  [[ "$output" == *'skipped: show: unsupported_platform'* ]]
}

@test "missing status prototypes is not proof of dismissal" {
  export MODE=malformed-status
  run_smoke
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: status shown:'* ]]
}

@test "a prototype still tracked after dismiss fails" {
  export MODE=stuck
  run_smoke
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: status dismissed:'* ]]
}

@test "supplied session is reused and consumed by this smoke" {
  export SMOKE_SESSION_UUID=smoke-session
  run_smoke
  [ "$status" -eq 0 ]
  ! grep -q 'getApple' "$CALLS"
  [ "$(grep -c -- '--daemon release-session smoke-session' "$CALLS")" -eq 1 ]
}

@test "release warning fails instead of claiming the session was released" {
  export MODE=release-fails
  run_smoke
  [ "$status" -eq 1 ]
  [[ "$output" == *'error: release session:'* ]]
}
