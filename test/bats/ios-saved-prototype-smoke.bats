#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  export TEST_DIR="$(mktemp -d)"
  export CALLS="$TEST_DIR/calls"; : > "$CALLS"
  mkdir "$TEST_DIR/template"
  cat > "$TEST_DIR/cli" <<'EOF'
#!/usr/bin/env bash
printf 'cli %s\n' "$*" >> "$CALLS"
args=("$@")
if [[ "${args[0]:-}" == --session-uuid ]]; then args=("${args[@]:2}"); fi
tool="${args[0]:-}"
case "$tool" in getApple|prototype|observe) ;; *) printf 'Invalid parameter format: %s. Parameters must start with --\n' "$tool" >&2; exit 2;; esac
args=("${args[@]:1}")
while ((${#args[@]})); do
  if [[ "${args[0]}" != --* ]]; then printf 'Invalid parameter format: %s. Parameters must start with --\n' "${args[0]}" >&2; exit 2; fi
  if ((${#args[@]} < 2)); then printf 'Missing value for %s\n' "${args[0]}" >&2; exit 2; fi
  args=("${args[@]:2}")
done
case "${CLI_MODE:-happy}:$*" in
  *getApple*) printf '{"runtime":{"session":{"sessionUuid":"acquired-session"}}}\n';;
  unsupported:*) echo '{"success":false,"errorCode":"unsupported_capability"}'; exit 1;;
  platform:*) echo '{"success":false,"errorCode":"unsupported_platform"}'; exit 1;;
  invalid:*) echo 'invalid action listSaved'; exit 2;;
  other:*) echo '{"success":false,"errorCode":"internal"}'; exit 1;;
  template-fail:*'--action save'*) echo 'viewer template missing VIEWER_TEMPLATE' >&2; exit 1;;
  *'--action listSaved'*)
    if [[ "$*" == *'--id '* ]]; then :; fi
    if [[ -f "$TEST_DIR/saved" ]]; then echo '{"success":true,"savedPrototypes":[{"id":"dev.jasonpearson.automobile.proto.test-slug"}]}';
    else echo '{"success":true,"savedPrototypes":[]}'; fi
    echo 'diagnostic' >&2;;
  observe-fail:*' observe '*) echo '{"success":false}'; exit 1;;
  *' observe '*) echo '{"success":true}';;
  second-false:*'--action save'*) if [[ -f "$TEST_DIR/saved" ]]; then echo '{"success":true,"saved":{"id":"smoke-saved-12259","slug":"test-slug","replaced":false}}'; else touch "$TEST_DIR/saved"; echo '{"success":true,"saved":{"id":"smoke-saved-12259","slug":"test-slug","replaced":false}}'; fi;;
  *'--action save'*) if [[ -f "$TEST_DIR/saved" ]]; then echo '{"success":true,"saved":{"id":"smoke-saved-12259","slug":"test-slug","replaced":true}}'; else touch "$TEST_DIR/saved"; echo '{"success":true,"saved":{"id":"smoke-saved-12259","slug":"test-slug","replaced":false}}'; fi;;
  *'--action deleteSaved'*) echo '{"success":true}'; if [[ "$*" == *'dev.jasonpearson.automobile.proto.test-slug'* && "${CLI_MODE:-happy}" != delete-listed ]]; then touch "$TEST_DIR/deleted"; rm -f "$TEST_DIR/saved"; fi;;
esac
EOF
  chmod +x "$TEST_DIR/cli"
  cat > "$TEST_DIR/xcrun" <<'EOF'
#!/usr/bin/env bash
printf 'xcrun %s\n' "$*" >> "$CALLS"
EOF
  chmod +x "$TEST_DIR/xcrun"
}
teardown() { rm -rf "$TEST_DIR"; }
run_smoke() {
  run env AUTO_MOBILE_CMD="$TEST_DIR/cli" XCRUN_BIN="$TEST_DIR/xcrun" AUTOMOBILE_IOS_PROTOTYPE_VIEWER_TEMPLATE="$TEST_DIR/template" SMOKE_SESSION_UUID=test-session SMOKE_LAUNCH_SETTLE_SECONDS=0 "$@" bash "$ROOT/scripts/ios/saved-prototype-smoke.sh" test-udid
}

@test "missing viewer template skips before CLI calls" {
  run env AUTO_MOBILE_CMD="$TEST_DIR/cli" bash "$ROOT/scripts/ios/saved-prototype-smoke.sh" test-udid
  [ "$status" -eq 0 ]; [ "$output" = 'skipped: iOS prototype viewer template unavailable (set AUTOMOBILE_IOS_PROTOTYPE_VIEWER_TEMPLATE or provide the release asset)' ]
  [ ! -s "$CALLS" ]
}

@test "blank and nonexistent template paths skip" {
  run env AUTO_MOBILE_CMD="$TEST_DIR/cli" AUTOMOBILE_IOS_PROTOTYPE_VIEWER_TEMPLATE='' AUTOMOBILE_IOS_PROTOTYPE_VIEWER="$TEST_DIR/missing" bash "$ROOT/scripts/ios/saved-prototype-smoke.sh" test-udid
  [ "$status" -eq 0 ]; [[ "$output" == 'skipped: iOS prototype viewer template unavailable ('* ]]
}

@test "feature absence variants skip without saving or launching" {
  for mode in unsupported platform invalid; do
    run_smoke CLI_MODE="$mode"; [ "$status" -eq 0 ]; [[ "$output" == *'skipped: iOS saved prototype actions not available in this build'* ]]
    [[ "$(cat "$CALLS")" != *'--action save'* ]]; [[ "$(cat "$CALLS")" != *'xcrun simctl launch'* ]]; : > "$CALLS"
  done
}

@test "other list failure is an error" { run_smoke CLI_MODE=other; [ "$status" -eq 1 ]; [[ "$output" == *'error: listSaved:'* ]]; }
@test "missing template reported by save skips" { run_smoke CLI_MODE=template-fail; [ "$status" -eq 0 ]; [[ "$output" == 'skipped: iOS prototype viewer template unavailable ('* ]]; }

@test "happy path follows save list launch observe replace delete order" {
  run_smoke; [ "$status" -eq 0 ]
  [[ "$output" == *'ok: save'*'ok: listSaved'*'ok: launch'*'ok: observe'*'ok: save again (replaced)'*'ok: deleteSaved'* ]]
  grep -q 'xcrun simctl launch test-udid dev.jasonpearson.automobile.proto.test-slug' "$CALLS"
  grep -q -- '--action deleteSaved --id dev.jasonpearson.automobile.proto.test-slug' "$CALLS"
  grep -Eq '^cli --session-uuid test-session prototype --deviceId test-udid --action [^ ]+' "$CALLS"
}

@test "second save must report replaced true" { run_smoke CLI_MODE=second-false; [ "$status" -eq 1 ]; [[ "$output" == *'error: save again (replaced):'* ]]; }
@test "observe failure triggers cleanup delete" { run_smoke CLI_MODE=observe-fail; [ "$status" -eq 1 ]; [[ "$output" == *'error: observe:'* ]]; [ "$(grep -c -- '--action deleteSaved' "$CALLS")" -ge 2 ]; }
@test "acquired session is released after observe failure and saved entry is deleted" {
  mkdir "$TEST_DIR/bin"
  cat > "$TEST_DIR/bin/auto-mobile" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == --daemon && "${2:-}" == release-session ]]; then printf 'release %s\n' "$*" >> "$CALLS"; else exec "$TEST_DIR/cli" "$@"; fi
EOF
  chmod +x "$TEST_DIR/bin/auto-mobile"
  run env PATH="$TEST_DIR/bin:$PATH" CLI_MODE=observe-fail AUTO_MOBILE_CMD="$TEST_DIR/bin/auto-mobile" XCRUN_BIN="$TEST_DIR/xcrun" AUTOMOBILE_IOS_PROTOTYPE_VIEWER_TEMPLATE="$TEST_DIR/template" SMOKE_LAUNCH_SETTLE_SECONDS=0 bash "$ROOT/scripts/ios/saved-prototype-smoke.sh" test-udid
  [ "$status" -eq 1 ]; grep -q 'release --daemon release-session acquired-session' "$CALLS"
  grep -q -- 'prototype --deviceId test-udid --action deleteSaved --id smoke-saved-12259' "$CALLS"
}
@test "delete leaving entry listed fails" { run_smoke CLI_MODE=delete-listed; [ "$status" -eq 1 ]; [[ "$output" == *'still listed'* ]]; }

@test "supplied session skips acquire and acquired session releases" {
  run_smoke; [ "$status" -eq 0 ]; [[ "$(cat "$CALLS")" != *getApple* ]]
  mkdir "$TEST_DIR/bin"
  cat > "$TEST_DIR/bin/auto-mobile" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == --daemon && "${2:-}" == release-session ]]; then printf 'release %s\n' "$*" >> "$CALLS"; else exec "$TEST_DIR/cli" "$@"; fi
EOF
  chmod +x "$TEST_DIR/bin/auto-mobile"
  run env PATH="$TEST_DIR/bin:$PATH" AUTO_MOBILE_CMD="$TEST_DIR/bin/auto-mobile" XCRUN_BIN="$TEST_DIR/xcrun" AUTOMOBILE_IOS_PROTOTYPE_VIEWER_TEMPLATE="$TEST_DIR/template" SMOKE_LAUNCH_SETTLE_SECONDS=0 bash "$ROOT/scripts/ios/saved-prototype-smoke.sh" test-udid
  [ "$status" -eq 0 ]; grep -q 'cli getApple --deviceId test-udid' "$CALLS"; grep -q 'release --daemon release-session acquired-session' "$CALLS"
}

@test "advisory wrapper always succeeds and classifies smoke/reset outcomes" {
  cat > "$TEST_DIR/smoke" <<'EOF'
#!/usr/bin/env bash
printf 'smoke %s tools=%s\n' "$*" "${AUTOMOBILE_ENABLED_TOOLS:-unset}" >> "$CALLS"
exit "${SMOKE_STATUS:-0}"
EOF
  cat > "$TEST_DIR/reset" <<'EOF'
#!/usr/bin/env bash
exit "${RESET_STATUS:-0}"
EOF
  chmod +x "$TEST_DIR/smoke" "$TEST_DIR/reset"
  for code in 0 1 124; do
    run env AUTOMOBILE_ENABLED_TOOLS=restricted SAVED_PROTOTYPE_SMOKE_CMD="$TEST_DIR/smoke" SAVED_PROTOTYPE_SMOKE_RESET_CMD="$TEST_DIR/reset" SAVED_PROTOTYPE_SMOKE_TIMEOUT_SECONDS=2 SMOKE_STATUS="$code" bash "$ROOT/scripts/ios/saved-prototype-smoke-advisory.sh" test-udid
    [ "$status" -eq 0 ]; [[ "$output" == *"Saved prototype smoke exit status: $code (advisory; does not fail the job)"* ]]
    if [ "$code" -eq 1 ]; then [[ "$output" == *'::warning title=Saved prototype smoke::saved prototype smoke failed (advisory)'* ]]; fi
    if [ "$code" -eq 124 ]; then [[ "$output" == *'::warning title=Saved prototype smoke::saved prototype smoke timed out (advisory)'* ]]; fi
  done
  run env SAVED_PROTOTYPE_SMOKE_CMD="$TEST_DIR/smoke" SAVED_PROTOTYPE_SMOKE_RESET_CMD="$TEST_DIR/reset" RESET_STATUS=1 bash "$ROOT/scripts/ios/saved-prototype-smoke-advisory.sh" test-udid
  [ "$status" -eq 0 ]; [[ "$output" == *'::warning title=Saved prototype smoke::daemon reset failed (advisory)'* ]]; grep -q 'smoke test-udid tools=unset' "$CALLS"
}

@test "both CI workflows place advisory step between navigation and daemon stop" {
  gh="$ROOT/.github/workflows/xctestrunner-simulator-tests.yml"; cc="$ROOT/.circleci/continue_config.yml"
  [ "$(grep -c 'Run saved prototype smoke (advisory)' "$gh")" -eq 1 ]
  awk '/Run iOS navigation graph Simulator workflow/{n=NR} /Run saved prototype smoke \(advisory\)/{s=NR} /Stop AutoMobile daemon before odd-width boot/{d=NR} END{exit !(n<s && s<d)}' "$gh"
  grep -A5 'Run saved prototype smoke (advisory)' "$gh" | grep -q 'continue-on-error: true'
  grep -A8 'Run saved prototype smoke (advisory)' "$gh" | grep -Fq 'steps.ctrlproxy-simulator.outputs.simulator_udid'
  awk '/Run iOS navigation graph Simulator workflow/{n=NR} /Run saved prototype smoke \(advisory\)/{s=NR} /Stop AutoMobile daemon before odd-width boot/{d=NR} END{exit !(n<s && s<d)}' "$cc"
  grep -A4 'Run saved prototype smoke (advisory)' "$cc" | grep -q 'no_output_timeout: 12m'
  grep -A4 'Run saved prototype smoke (advisory)' "$cc" | grep -Fq '"${SIMULATOR_UDID}"'
}
