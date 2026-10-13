#!/usr/bin/env bats
setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$ROOT/scripts/android/prototype-frame-benchmark.sh"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  export PROTOTYPE_BENCH_ADB="$BATS_TEST_TMPDIR/adb-stub"
  export PROTOTYPE_BENCH_CLI="$BATS_TEST_TMPDIR/cli-stub"
  export AUTOMOBILE_SESSION_UUID=private-session
  SCENARIOS="$BATS_TEST_TMPDIR/scenarios.json"
  jq 'map(.settleMs=0 | if has("durationMs") then .durationMs=0 else . end)' "$ROOT/benchmark/prototype-frame/scenarios.json" > "$SCENARIOS"
  cat > "$PROTOTYPE_BENCH_CLI" <<'STUB'
#!/usr/bin/env bash
printf 'cli' >> "$CALLS"
printf ' <%s>' "$@" >> "$CALLS"
printf '\n' >> "$CALLS"
STUB
  cat > "$PROTOTYPE_BENCH_ADB" <<'STUB'
#!/usr/bin/env bash
printf 'adb' >> "$CALLS"
printf ' <%s>' "$@" >> "$CALLS"
printf '\n' >> "$CALLS"
[[ "${7:-}" == reset ]] && exit 0
if [[ -n "${FAIL_CAPTURE:-}" && ! -e "$CALLS.failed" ]]; then
  touch "$CALLS.failed"
  exit 1
fi
if [[ -n "${MISSING_FIELDS:-}" ]]; then echo 'Total frames rendered: 100'; exit 0; fi
# Synthetic gfxinfo sample (field layout as in src/features/performance tests); a device capture is owed (#12128).
cat <<'DUMP'
Total frames rendered: 100
Janky frames: 5 (5.00%)
50th percentile: 8ms
90th percentile: 12ms
95th percentile: 16ms
99th percentile: 22ms
Number Slow UI thread: 1
DUMP
if [[ -n "${WINDOW_SECTION:-}" ]]; then
  cat <<'DUMP'
Window: benchmark
Total frames rendered: 3
Janky frames: 2 (66.67%)
50th percentile: 30ms
90th percentile: 40ms
95th percentile: 50ms
99th percentile: 60ms
Number Slow UI thread: 2
DUMP
fi
if [[ -n "${MIDLINE_FIELDS:-}" ]]; then
  cat <<'DUMP'
Diagnostic Total frames rendered: 999
Diagnostic Janky frames: 999 (99.99%)
Diagnostic 50th percentile: 999ms
Diagnostic 90th percentile: 999ms
Diagnostic 95th percentile: 999ms
Diagnostic 99th percentile: 999ms
Diagnostic Number Slow UI thread: 999
DUMP
fi
STUB
  chmod +x "$PROTOTYPE_BENCH_ADB" "$PROTOTYPE_BENCH_CLI"
}
@test "list returns seven names without calling either command" {
  run "$SCRIPT" --list
  [ "$status" -eq 0 ]
  [ "$output" = $'idle\ntab-switch\nsection-collapse\npager-swipe\nscroll\noverlay-open\nthree-write-tap' ]
  [ ! -e "$CALLS" ]
}
@test "dry-run prints commands without executing them even without a device" {
  run "$SCRIPT" --dry-run --scenarios "$SCENARIOS"
  [ "$status" -eq 0 ]
  [ ! -e "$CALLS" ]
  [[ "$output" == *'gfxinfo dev.jasonpearson.automobile.ctrlproxy reset'* ]]
  [[ "$output" == *'gfxinfo dev.jasonpearson.automobile.ctrlproxy '* ]]
  [[ "$output" == *'prototype --action show --specPath'* ]]
  [[ "$output" == *'prototype --action dismiss --id perf-benchmark'* ]]
  [[ "$output" == *'tapOn --layer prototype --selector'* ]]
  [[ "$output" == *'swipeOn --layer prototype --container'* ]]
}
@test "device is mandatory and bad options or scenarios exit two" {
  run "$SCRIPT"
  [ "$status" -eq 2 ]; [[ "$output" == *'--device is required'* ]]
  run "$SCRIPT" --bogus
  [ "$status" -eq 2 ]
  run "$SCRIPT" --list --scenario bogus
  [ "$status" -eq 2 ]
  [ ! -e "$CALLS" ]
}
@test "stubbed scenarios bracket steps parse metrics and retain device session" {
  run "$SCRIPT" --device test-device --show-settle-ms 0 --scenarios "$SCENARIOS"
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -c '^scenario=')" -eq 7 ]
  [ "$(printf '%s\n' "$output" | grep -c 'frames=100 janky_pct=5.00 p50_ms=8 p90_ms=12 p95_ms=16 p99_ms=22 slow_ui=1$')" -eq 7 ]
  [ "$(grep -c '<reset>' "$CALLS")" -eq 7 ]
  [ "$(grep -c '<show>' "$CALLS")" -eq 1 ]
  [ "$(grep -c '<dismiss>' "$CALLS")" -eq 1 ]
  [ "$(grep -c '"text":"Tab 2"' "$CALLS")" -eq 5 ]
  [ "$(grep -c '<swipeOn>' "$CALLS")" -eq 16 ]
  ! grep '^cli' "$CALLS" | grep -v '<--deviceId> <test-device>'
  ! grep '^cli' "$CALLS" | grep -v '<--session-uuid> <private-session>'
  # Every scenario starts with reset and ends with capture, with no steps outside a bracket.
  awk '/^adb/ { if ($0 ~ /<reset>/) { if(open) exit 1; open=1; next } if(!open) exit 1; open=0; next }
       /<tapOn>|<swipeOn>/ { if(!open) exit 1 }
       END { if(open) exit 1 }' "$CALLS"
}
@test "capture failure continues through remaining scenarios and dismisses" {
  FAIL_CAPTURE=1 run "$SCRIPT" --device test-device --show-settle-ms 0 --scenarios "$SCENARIOS"
  [ "$status" -eq 1 ]
  [[ "$output" == *'scenario=idle error=capture-failed'* ]]
  [ "$(printf '%s\n' "$output" | grep -c '^scenario=')" -eq 7 ]
  [[ "$output" == *'scenario=three-write-tap frames=100'* ]]
  [ "$(grep -c '<dismiss>' "$CALLS")" -eq 1 ]
}
@test "missing fields produce errors while filters and markdown work" {
  MISSING_FIELDS=1 run "$SCRIPT" --device test-device --show-settle-ms 0 --scenarios "$SCENARIOS" --scenario idle --scenario tab-switch
  [ "$status" -eq 1 ]
  [ "$(printf '%s\n' "$output" | grep -c 'error=missing-fields')" -eq 2 ]
  [ "$(grep -c '<reset>' "$CALLS")" -eq 2 ]
  run "$SCRIPT" --device test-device --show-settle-ms 0 --scenarios "$SCENARIOS" --scenario idle --markdown
  [ "$status" -eq 0 ]
  [[ "$output" == *'| idle | 100 | 5.00 | 8 | 12 | 16 | 22 | 1 | — |'* ]]
}

@test "capture retains the first process summary before per-window and mid-line fields" {
  WINDOW_SECTION=1 MIDLINE_FIELDS=1 run "$SCRIPT" --device test-device --show-settle-ms 0 --scenarios "$SCENARIOS" --scenario idle
  [ "$status" -eq 0 ]
  [[ "$output" == *'scenario=idle frames=100 janky_pct=5.00 p50_ms=8 p90_ms=12 p95_ms=16 p99_ms=22 slow_ui=1'* ]]
}
@test "capture ignores mid-line field names even before the first anchored occurrence" {
  # Put diagnostic lines before the normal summary to distinguish anchoring from first-only matching.
  cp "$PROTOTYPE_BENCH_ADB" "$BATS_TEST_TMPDIR/summary-stub"
  cat > "$PROTOTYPE_BENCH_ADB" <<'STUB'
#!/usr/bin/env bash
[[ "${7:-}" == reset ]] && exec "$BATS_TEST_TMPDIR/summary-stub" "$@"
cat <<'DUMP'
Diagnostic Total frames rendered: 999
Diagnostic Janky frames: 999 (99.99%)
Diagnostic 50th percentile: 999ms
Diagnostic 90th percentile: 999ms
Diagnostic 95th percentile: 999ms
Diagnostic 99th percentile: 999ms
Diagnostic Number Slow UI thread: 999
DUMP
exec "$BATS_TEST_TMPDIR/summary-stub" "$@"
STUB
  WINDOW_SECTION=1 run "$SCRIPT" --device test-device --show-settle-ms 0 --scenarios "$SCENARIOS" --scenario idle
  [ "$status" -eq 0 ]
  [[ "$output" == *'scenario=idle frames=100 janky_pct=5.00 p50_ms=8 p90_ms=12 p95_ms=16 p99_ms=22 slow_ui=1'* ]]
}
@test "show-settle rejects non-numbers and negative or fractional values" {
  for value in nope -1 1.5; do
    run "$SCRIPT" --dry-run --show-settle-ms "$value" --scenarios "$SCENARIOS"
    [ "$status" -eq 2 ]
    [[ "$output" == *'--show-settle-ms must be a non-negative integer'* ]]
  done
  [ ! -e "$CALLS" ]
}
@test "dry-run prints show-settle sleep between show and the first reset" {
  run "$SCRIPT" --dry-run --show-settle-ms 1250 --scenarios "$SCENARIOS" --scenario idle
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == *'prototype --action show --specPath'* ]]
  [ "${lines[1]}" = 'sleep 1.25 ' ]
  [[ "${lines[2]}" == *'gfxinfo dev.jasonpearson.automobile.ctrlproxy reset'* ]]
  run "$SCRIPT" --dry-run --scenarios "$SCENARIOS" --scenario idle
  [ "$status" -eq 0 ]
  [ "${lines[1]}" = 'sleep 2 ' ]
  run "$SCRIPT" --dry-run --show-settle-ms 0 --scenarios "$SCENARIOS" --scenario idle
  [ "$status" -eq 0 ]
  [[ "${lines[1]}" == *'gfxinfo dev.jasonpearson.automobile.ctrlproxy reset'* ]]
  [ ! -e "$CALLS" ]
}
