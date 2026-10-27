#!/usr/bin/env bats
# Portable shell tests: CLI is stubbed; no simulator or platform commands run.
setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$ROOT/scripts/ios/prototype-feed-benchmark.sh"
  export PROTOTYPE_BENCH_CLI="$BATS_TEST_TMPDIR/cli"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  export AUTOMOBILE_SESSION_UUID=private-session
  cat > "$PROTOTYPE_BENCH_CLI" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
if [[ "$*" == *'--action show'* ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --specPath ]]; then cp "$2" "$CALLS.spec"; fi
    shift
  done
  exit "${SHOW_STATUS:-0}"
fi
if [[ "$*" == *'swipeOn'* ]]; then exit "${SWIPE_STATUS:-0}"; fi
STUB
  chmod +x "$PROTOTYPE_BENCH_CLI"
}
@test "ios dry-run prints show swipes and cleanup without calling CLI" {
  run "$SCRIPT" --device fake-udid --rows 10 --swipes 4 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *'prototype --action show --specPath'* ]]
  [[ "$output" == *'prototype --action dismiss --id perf-feed'* ]]
  [[ "$output" == *'--deviceId fake-udid'* ]]
  [[ "$output" == *'wall_time_ms=n/a'* ]]
  [ "$(printf '%s\n' "$output" | grep -c 'swipeOn')" -eq 4 ]
  [ ! -e "$CALLS" ]
}
@test "ios stubbed run reports wall time only and retains device session" {
  run "$SCRIPT" --device fake-udid --rows 10 --swipes 2
  [ "$status" -eq 0 ]
  [[ "$output" == *'scroll_step=1 direction=up wall_ms='* ]]
  [[ "$output" == *'scroll_step=2 direction=down wall_ms='* ]]
  [[ "$output" == *'scroll_total swipes=2 wall_ms='*'metric=scripted-scroll-wall-time'* ]]
  [[ "$output" != *'p95'* ]]
  [ "$(grep -c swipeOn "$CALLS")" -eq 2 ]
  ! grep -v -- '--deviceId fake-udid' "$CALLS"
  ! grep -v -- '--session-uuid private-session' "$CALLS"
  [ "$(jq '.data.feed.items | length' "$CALLS.spec")" -eq 10 ]
  spec_path=$(sed -n 's/.*--specPath \([^ ]*\).*/\1/p' "$CALLS")
  [ ! -e "$spec_path" ]
}
@test "ios validates device rows and swipe bounds" {
  run "$SCRIPT"
  [ "$status" -eq 2 ]
  for value in 0 -1 1.5 nope 101 999999999999999999999; do
    run "$SCRIPT" --dry-run --swipes "$value"
    [ "$status" -eq 2 ]
    [[ "$output" == *'--swipes must be an integer in 1..100'* ]]
  done
  run "$SCRIPT" --dry-run --rows 0
  [ "$status" -eq 2 ]
  [ ! -e "$CALLS" ]
}
@test "ios show or swipe failure dismisses and preserves failure status" {
  SHOW_STATUS=7 run "$SCRIPT" --device fake-udid
  [ "$status" -eq 7 ]
  grep -q -- '--action dismiss' "$CALLS"
  rm "$CALLS"
  SWIPE_STATUS=8 run "$SCRIPT" --device fake-udid
  [ "$status" -eq 8 ]
  grep -q -- '--action dismiss' "$CALLS"
}
