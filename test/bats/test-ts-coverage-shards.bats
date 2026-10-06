#!/usr/bin/env bats

SCRIPT="scripts/test-ts.sh"

setup() {
  STUB_BIN="$(mktemp -d)"
  REAL_BUN="$(command -v bun)"
  export REAL_BUN
  cat > "$STUB_BIN/bun" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "scripts/lib/merge-lcov.ts" || "$1" == "scripts/lib/merge-junit-reports.ts" || "$1" == "scripts/lib/write-coverage-bunfig.ts" ]]; then
  exec "$REAL_BUN" "$@"
fi
all_args=("$@")
coverage_config=""
report=""
shard=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --config=*) coverage_config="${1#*=}" ;;
    --reporter-outfile) report="$2"; shift ;;
    --shard=*) shard="${1#*=}" ;;
  esac
  shift
done
[[ -n "$shard" && -n "$coverage_config" && -n "$report" ]] || exit 70
number="${shard%%/*}"
coverage_dir="coverage/shards/shard-${number}"
grep -q "coverageDir = \"${coverage_dir}\"" "$coverage_config" || exit 71
printf '%s\n' "$shard" > "${coverage_dir%/*}/invoked-${number}"
printf '%s\n' "${all_args[@]}" > "${coverage_dir%/*}/args-${number}"
printf '%s\n' "${AUTOMOBILE_TEST_TIMING_LOG:-}" > "${coverage_dir%/*}/timing-env-${number}"
echo "log from shard $number"
if [[ "$number" == "${STUB_WRITE_FAILED_SHARD:-}" ]]; then
  echo 'error: An internal error occurred (WriteFailed)'
  echo '0 fail'
elif [[ "$number" == "${STUB_REAL_FAIL_SHARD:-}" ]]; then
  echo '1 fail'
else
  echo '0 fail'
fi
mkdir -p "$coverage_dir"
cat > "$coverage_dir/lcov.info" <<LCOV
TN:
SF:src/shared.ts
FN:1,shared
FNDA:${number},shared
FNF:2
FNH:${number}
BRDA:1,0,0,${number}
BRF:1
BRH:1
DA:1,${number}
LF:1
LH:1
end_of_record
TN:
SF:src/only-${number}.ts
DA:1,1
LF:1
LH:1
end_of_record
LCOV
cat > "$report" <<JUNIT
<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="1" failures="0" time="0.001"><testsuite name="shard-${number}" tests="1" failures="0" time="0.001"><testcase name="case" classname="shard-${number}" file="test/shard-${number}.test.ts" time="0.001" /></testsuite></testsuites>
JUNIT
if [[ "$number" == "${STUB_FAIL_SHARD:-}" || "$number" == "${STUB_WRITE_FAILED_SHARD:-}" || "$number" == "${STUB_REAL_FAIL_SHARD:-}" ]]; then exit 7; fi
EOF
  chmod +x "$STUB_BIN/bun"
}

teardown() {
  rm -rf "$STUB_BIN" coverage
}

@test "coverage defaults to four isolated shards and merges overlapping LCOV and JUnit" {
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 bash "$SCRIPT" coverage
  [ "$status" -eq 0 ]
  for number in 1 2 3 4; do
    [ -f "coverage/shards/invoked-${number}" ]
    [ -f "coverage/shards/shard-${number}.log" ]
  done
  [ ! -f coverage/shards/invoked-5 ]
  [[ "$output" == *"log from shard 1"*"log from shard 2"*"log from shard 3"*"log from shard 4"* ]]
  [ "$(grep -c '^SF:src/shared.ts$' coverage/lcov.info)" -eq 1 ]
  grep -q '^FNDA:10,shared$' coverage/lcov.info
  grep -q '^FNF:2$' coverage/lcov.info
  grep -q '^BRDA:1,0,0,10$' coverage/lcov.info
  grep -q '^DA:1,10$' coverage/lcov.info
  [ "$(grep -c '^SF:src/only-' coverage/lcov.info)" -eq 4 ]
  grep -q 'tests="4"' coverage/junit.xml
  for number in 1 2 3 4; do
    grep -q "shard-${number}" coverage/junit.xml
  done
}

@test "four coverage shards request every shard index of four over one identical file list" {
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 \
    bash "$SCRIPT" coverage test/scripts/testLaneClassification.test.ts test/setup/auxSocketDir.test.ts
  [ "$status" -eq 0 ]
  for number in 1 2 3 4; do
    [ "$(cat "coverage/shards/invoked-${number}")" = "${number}/4" ]
    grep -qx -- '--coverage' "coverage/shards/args-${number}"
    grep -qx -- 'test/scripts/testLaneClassification.test.ts' "coverage/shards/args-${number}"
    grep -qx -- 'test/setup/auxSocketDir.test.ts' "coverage/shards/args-${number}"
    grep -q -- "shard-${number}.xml" "coverage/shards/args-${number}"
    # The per-file timing/RSS probe is loaded and logs beside each shard's output.
    grep -q -- 'test/setup/fileTimingProbe.ts' "coverage/shards/args-${number}"
    [ "$(cat "coverage/shards/timing-env-${number}")" = "coverage/shards/timing-shard-${number}.ndjson" ]
  done
}

@test "four Bun shards partition a file list completely and disjointly" {
  # Real Bun, in an empty directory (no repo bunfig/preloads), over tiny files.
  local dir="$BATS_TEST_TMPDIR/partition" files=() number total=13
  mkdir -p "$dir"
  for ((number = 1; number <= total; number += 1)); do
    printf 'import { test } from "bun:test";\ntest("case", () => {});\n' > "$dir/f${number}.test.ts"
    files+=("f${number}.test.ts")
  done
  : > "$dir/seen"
  for number in 1 2 3 4; do
    (cd "$dir" && "$REAL_BUN" test --shard="${number}/4" --reporter junit \
      --reporter-outfile "shard-${number}.xml" "${files[@]}" > "shard-${number}.log" 2>&1)
    grep -o 'file="[^"]*"' "$dir/shard-${number}.xml" | sort -u >> "$dir/seen"
  done
  # Complete: every file ran. Disjoint: no file ran in two shards.
  [ "$(wc -l < "$dir/seen" | tr -d ' ')" -eq "$total" ]
  [ "$(sort -u "$dir/seen" | wc -l | tr -d ' ')" -eq "$total" ]
}

@test "coverage shard count is configurable and invalid values fail before Bun" {
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_COVERAGE_SHARDS=3 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 bash "$SCRIPT" coverage
  [ "$status" -eq 0 ]
  [ -f coverage/shards/invoked-3 ]
  [ "$(grep -c '^SF:' coverage/lcov.info)" -eq 4 ]

  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_COVERAGE_SHARDS=1 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 bash "$SCRIPT" coverage
  [ "$status" -eq 0 ]
  cmp coverage/shards/shard-1/lcov.info coverage/lcov.info
  cmp coverage/shards/shard-1.xml coverage/junit.xml

  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_COVERAGE_SHARDS=0 bash "$SCRIPT" coverage
  [ "$status" -eq 2 ]
  [[ "$output" == *"AUTOMOBILE_COVERAGE_SHARDS must be a positive integer"* ]]
}

@test "a failing shard names its index and prevents the merged artifacts" {
  run env PATH="$STUB_BIN:$PATH" STUB_FAIL_SHARD=2 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 bash "$SCRIPT" coverage
  [ "$status" -ne 0 ]
  [[ "$output" == *"coverage shard 2/4 exited with status 7"* ]]
  [ ! -f coverage/lcov.info ]
  [ ! -f coverage/junit.xml ]
}

@test "a timed-out shard retains the 720 second guard and names its index" {
  cat > "$STUB_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
exit 124
EOF
  chmod +x "$STUB_BIN/timeout"
  run env PATH="$STUB_BIN:$PATH" bash "$SCRIPT" coverage
  [ "$status" -eq 124 ]
  [[ "$output" == *"Coverage test run exceeded its 720s wall-clock budget (shard 1/4)"* ]]
  [ ! -f coverage/lcov.info ]
}

@test "WriteFailed after zero failures recovers and merges shard coverage" {
  run env PATH="$STUB_BIN:$PATH" STUB_WRITE_FAILED_SHARD=2 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 bash scripts/ci/run-ts-coverage.sh
  [ "$status" -eq 0 ]
  [ -f coverage/lcov.info ]
  [ -f coverage/junit.xml ]
  [ "$(grep -c '^SF:src/shared.ts$' coverage/lcov.info)" -eq 1 ]
  grep -q '^FNDA:10,shared$' coverage/lcov.info
}

@test "WriteFailed on one shard does not tolerate another shard real failures" {
  run env PATH="$STUB_BIN:$PATH" STUB_WRITE_FAILED_SHARD=2 STUB_REAL_FAIL_SHARD=1 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 bash scripts/ci/run-ts-coverage.sh
  [ "$status" -ne 0 ]
  [ ! -f coverage/lcov.info ]
}
