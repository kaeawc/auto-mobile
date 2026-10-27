#!/usr/bin/env bats
setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$ROOT/scripts/android/prototype-feed-benchmark.sh"
  export PROTOTYPE_FEED_BENCH_FRAME="$BATS_TEST_TMPDIR/frame"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  cat > "$PROTOTYPE_FEED_BENCH_FRAME" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$CALLS"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --spec) cp "$2" "$CALLS.spec"; shift 2 ;;
    --markdown) exit 99 ;;
    *) shift ;;
  esac
done
printf '%s\n' 'scenario=feed-idle frames=0 p95_ms=n/a' \
  "scenario=feed-scroll-down frames=100 p95_ms=${P95:-15.9}" \
  'scenario=feed-fling-roundtrip error=capture-failed'
exit "${FRAME_STATUS:-0}"
STUB
  chmod +x "$PROTOTYPE_FEED_BENCH_FRAME"
}
@test "dry-run delegates generated spec and scenarios without verdicts" {
  run "$SCRIPT" --dry-run --rows 1000 --package example.package
  [ "$status" -eq 0 ]
  grep -q -- '--dry-run' "$CALLS"
  grep -q 'feed-scenarios.json' "$CALLS"
  grep -q 'example.package' "$CALLS"
  [[ "$output" != *'verdict '* ]]
  [ "$(jq '.data.feed.items | length' "$CALLS.spec")" -eq 1000 ]
  spec_path=$(awk 'previous=="--spec" {print;exit} {previous=$0}' "$CALLS")
  [ ! -e "$spec_path" ]
}
@test "real harness dry-run validates all feed scenarios without executing CLI or adb" {
  unset PROTOTYPE_FEED_BENCH_FRAME
  export PROTOTYPE_BENCH_CLI="$BATS_TEST_TMPDIR/must-not-run"
  export PROTOTYPE_BENCH_ADB="$BATS_TEST_TMPDIR/must-not-run"
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *'swipeOn --layer prototype --container'* ]]
  [[ "$output" == *'perf-feed'* ]]
  [[ "$output" == *'sleep 3 '* ]]
}
@test "rows reject invalid values before harness execution" {
  cap=$(jq '.limits.MAX_PROTOTYPE_LIST_ITEMS' "$ROOT/schemas/prototype-spec-contract.json")
  for rows in 0 -1 1.5 nope 1e3 "$((cap+1))" 99999999999999999999; do
    run "$SCRIPT" --dry-run --rows "$rows"
    [ "$status" -eq 2 ]
    [[ "$output" == *"--rows must be an integer in 1..$cap"* ]]
  done
  [ ! -e "$CALLS" ]
}
@test "device and option values are required" {
  run "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *'--device is required'* ]]
  for option in --rows --device --package --bogus; do
    run "$SCRIPT" "$option"
    [ "$status" -eq 2 ]
  done
  [ ! -e "$CALLS" ]
}
@test "verdicts parse pass and n-a and markdown renders in wrapper" {
  run "$SCRIPT" --device stub --markdown --enforce
  [ "$status" -eq 0 ]
  [[ "$output" == *'verdict scenario=feed-idle p95_ms=n/a target_ms=16 result=n/a'* ]]
  [[ "$output" == *'verdict scenario=feed-scroll-down p95_ms=15.9 target_ms=16 result=pass'* ]]
  [[ "$output" == *'verdict scenario=feed-fling-roundtrip p95_ms=n/a target_ms=16 result=n/a'* ]]
  [[ "$output" == *'| feed-scroll-down | 15.9 | 16 | pass |'* ]]
}
@test "p95 at or above target fails only with enforce" {
  for value in 16 22.5; do
    P95="$value" run "$SCRIPT" --device stub
    [ "$status" -eq 0 ]
    [[ "$output" == *"p95_ms=$value target_ms=16 result=fail"* ]]
    P95="$value" run "$SCRIPT" --device stub --enforce
    [ "$status" -eq 1 ]
  done
}
@test "harness failures retain exit status and missing results are n-a" {
  FRAME_STATUS=7 run "$SCRIPT" --device stub
  [ "$status" -eq 7 ]
  cat > "$PROTOTYPE_FEED_BENCH_FRAME" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
  run "$SCRIPT" --device stub --enforce
  [ "$status" -eq 1 ]
  [ "$(printf '%s\n' "$output" | grep -c 'result=n/a')" -eq 3 ]
}
@test "generator stdout and out are identical valid JSON including paging" {
  run bun "$ROOT/scripts/prototype/generate-feed-benchmark-spec.ts" --rows 1
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" > "$BATS_TEST_TMPDIR/stdout.json"
  run bun "$ROOT/scripts/prototype/generate-feed-benchmark-spec.ts" --rows 1 --out "$BATS_TEST_TMPDIR/out.json"
  [ "$status" -eq 0 ]
  cmp "$BATS_TEST_TMPDIR/stdout.json" "$BATS_TEST_TMPDIR/out.json"
  [ "$(jq -r '.root.contentDescription' "$BATS_TEST_TMPDIR/out.json")" = 'Benchmark feed' ]
  run bun "$ROOT/scripts/prototype/generate-feed-benchmark-spec.ts" --rows 4 --paging --page-url http://localhost:8080/page
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | jq -r '.root.onEndReached[0].append.to')" = /data/feed/items ]
  run bun "$ROOT/scripts/prototype/generate-feed-benchmark-spec.ts" --paging
  [ "$status" -eq 2 ]
}
