#!/usr/bin/env bats
#
# Guards scripts/android/performance-tool-smoke.sh (#18725). The CLI and adb are
# stubs; the trace artifact's bytes are never interpreted by the script (only
# its size is), so the stub writes an opaque placeholder or nothing.

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  export TEST_DIR="$(mktemp -d)"
  export CALLS="$TEST_DIR/calls"
  export ARTIFACT="$TEST_DIR/trace.perfetto-trace"
  : > "$CALLS"
  cat > "$TEST_DIR/cli" <<'EOF'
#!/usr/bin/env bash
printf 'cli %s\n' "$*" >> "$CALLS"
case "$*" in
  *getAndroid*) printf '{"runtime":{"session":{"sessionUuid":"acquired-session"}}}\n' ;;
  *'performanceTrace --action start'*)
    [[ "${MODE:-}" == start-fails ]] && { echo 'Error: perfetto failed to start' >&2; exit 1; }
    printf '{"success":true,"action":"start","traceId":"t-1","state":"recording"}\n' ;;
  *'performanceTrace --action stop'*)
    [[ "${MODE:-}" == empty-artifact ]] && : > "$ARTIFACT" || printf 'opaque' > "$ARTIFACT"
    if [[ "${MODE:-}" == summary ]]; then
      printf '{"success":true,"action":"stop","traceId":"t-1","state":"stopped","artifactPath":"%s","summary":{"launch":{"durationMs":812,"phases":[]}},"warnings":[]}\n' "$ARTIFACT"
    elif [[ "${MODE:-}" == no-summary ]]; then
      printf '{"success":true,"action":"stop","traceId":"t-1","state":"stopped","artifactPath":"%s","summary":{},"warnings":[]}\n' "$ARTIFACT"
    else
      printf '{"success":true,"action":"stop","traceId":"t-1","state":"stopped","artifactPath":"%s","summary":{},"warnings":["trace_processor_shell was not found on the host; install it. The trace artifact is complete."]}\n' "$ARTIFACT"
    fi ;;
  *performanceAudit*)
    if [[ "${MODE:-}" == audit-fails ]]; then
      printf '{"success":true,"failed":false,"performance":{"passed":false}}\n'
    else
      printf '{"success":true,"failed":false,"performance":{"passed":true}}\n'
    fi ;;
  *measureStartup*)
    if [[ "${MODE:-}" == one-sample ]]; then
      printf '{"success":true,"ttid":{"min":420,"p50":420,"p90":420,"max":420,"samples":[420]}}\n'
    else
      printf '{"success":true,"ttid":{"min":410,"p50":430,"p90":430,"max":430,"samples":[410,430]}}\n'
    fi ;;
esac
EOF
  chmod +x "$TEST_DIR/cli"
  cat > "$TEST_DIR/adb" <<'EOF'
#!/usr/bin/env bash
printf 'adb %s\n' "$*" >> "$CALLS"
case "$*" in
  devices) echo 'List of devices attached'; echo 'emulator-5554 device' ;;
  *' pm path '*) [[ "${NOT_INSTALLED:-0}" == 0 ]] || exit 1 ;;
  *' am start '*) [[ "${AM_START_FAIL:-0}" == 0 ]] || exit 1 ;;
esac
EOF
  chmod +x "$TEST_DIR/adb"
}

teardown() { rm -rf "$TEST_DIR"; }

run_smoke() {
  run env ADB_BIN="$TEST_DIR/adb" AUTO_MOBILE_CMD="$TEST_DIR/cli" SMOKE_SESSION_UUID=test-session \
    PERF_SMOKE_FLOW_SLEEP=0 "$@" bash "$ROOT/scripts/android/performance-tool-smoke.sh" emulator-5554
}

@test "traces a cold launch, audits the idle screen, then measures two cold starts" {
  run_smoke
  [ "$status" -eq 0 ]
  [[ "$output" == *'PASS: performanceTrace artifact is non-empty (6 bytes)'* ]]
  [[ "$output" == *'skipped: trace summary (trace_processor_shell is not on this host)'* ]]
  [[ "$output" == *'PASS: performanceAudit idle screen passes'* ]]
  [[ "$output" == *'PASS: measureStartup cold reports two positive TTID samples'* ]]
  # The launch happens inside the trace.
  run grep -nE 'action start|am start|action stop' "$CALLS"
  [[ "${lines[0]}" == *'performanceTrace --action start --template appLaunch'* ]]
  [[ "${lines[1]}" == *'am start -W -n dev.jasonpearson.automobile.playground/.MainActivity'* ]]
  [[ "${lines[2]}" == *'performanceTrace --action stop --traceId t-1'* ]]
  grep -q -- "--kinds \\[\"performance\"\\]" "$CALLS"
  grep -q -- '--mode cold --iterations 2' "$CALLS"
}

@test "with trace_processor_shell a summary launch entry is required and accepted" {
  run_smoke MODE=summary
  [ "$status" -eq 0 ]
  [[ "$output" == *'PASS: performanceTrace summary parsed a launch or frames'* ]]
}

@test "a summary without launch or frames fails when trace_processor_shell ran" {
  run_smoke MODE=no-summary
  [ "$status" -ne 0 ]
  [[ "$output" == *'FAIL: performanceTrace summary parsed a launch or frames'* ]]
}

@test "a 0-byte trace artifact (broken Perfetto config) fails" {
  run_smoke MODE=empty-artifact
  [ "$status" -ne 0 ]
  [[ "$output" == *'FAIL: performanceTrace artifact is missing or empty'* ]]
  ! grep -q performanceAudit "$CALLS"
}

@test "a trace that cannot start fails with the tool's error" {
  run_smoke MODE=start-fails
  [ "$status" -ne 0 ]
  [[ "$output" == *'FAIL: performanceTrace start'*'perfetto failed to start'* ]]
}

@test "a failing idle audit fails the smoke" {
  run_smoke MODE=audit-fails
  [ "$status" -ne 0 ]
  [[ "$output" == *'FAIL: performanceAudit idle screen passes'* ]]
  ! grep -q measureStartup "$CALLS"
}

@test "measureStartup must report both cold samples" {
  run_smoke MODE=one-sample
  [ "$status" -ne 0 ]
  [[ "$output" == *'FAIL: measureStartup cold reports two positive TTID samples'* ]]
}

@test "a missing Playground app fails before any tool runs" {
  run_smoke NOT_INSTALLED=1
  [ "$status" -ne 0 ]
  [[ "$output" == *'is not installed'* ]]
  ! grep -q '^cli ' "$CALLS"
}

@test "without a session it acquires one and releases it on exit" {
  run env ADB_BIN="$TEST_DIR/adb" AUTO_MOBILE_CMD="$TEST_DIR/cli" PERF_SMOKE_FLOW_SLEEP=0 \
    bash "$ROOT/scripts/android/performance-tool-smoke.sh" emulator-5554
  [ "$status" -eq 0 ]
  grep -q 'getAndroid --deviceId emulator-5554' "$CALLS"
  grep -q -- '--session-uuid acquired-session performanceTrace' "$CALLS"
  grep -q -- '--daemon release-session acquired-session' "$CALLS"
}

@test "a failure while recording stops the trace on exit and keeps a reused session" {
  run_smoke AM_START_FAIL=1
  [ "$status" -ne 0 ]
  [[ "$output" == *'FAIL: launch Playground inside the trace'* ]]
  grep -q -- 'performanceTrace --action stop --traceId t-1' "$CALLS"
  ! grep -q -- 'release-session' "$CALLS"
}
