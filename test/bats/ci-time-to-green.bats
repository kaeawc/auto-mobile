#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# CLI contract of scripts/ci/ci-time-to-green.ts (#11582): flags, exit codes and
# the read-only guarantee. `gh` is a stub on PATH that serves captured API
# responses from test/fixtures/ci-time-to-green/, so nothing here reaches the
# network. The aggregation maths is unit-tested in
# test/scripts/ciTimeToGreenReport.test.ts.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/ci-time-to-green.ts"
FIXTURES="$REPO_ROOT/test/fixtures/ci-time-to-green"

setup() {
  TEST_ROOT="$(mktemp -d)"
  mkdir -p "$TEST_ROOT/bin"
  export GH_STUB_LOG="$TEST_ROOT/gh.log"
  export GH_STUB_FIXTURES="$FIXTURES"
  cat > "$TEST_ROOT/bin/gh" << 'STUB'
#!/usr/bin/env bash
# Serves captured responses; records every invocation so tests can assert read-only use.
echo "$*" >> "$GH_STUB_LOG"
if [ "$1" = "repo" ]; then
  echo "kaeawc/auto-mobile"
  exit 0
fi
path="${*: -1}"
case "$path" in
  */rulesets) echo '[{"id":1}]' ;;
  */rulesets/1) cat "$GH_STUB_FIXTURES/ruleset.json" ;;
  */actions/runs\?*)
    if [ "${GH_STUB_MODE:-}" = "ratelimit" ]; then
      echo "gh: API rate limit exceeded for user (HTTP 403)" >&2
      exit 1
    fi
    jq -c '{total_count: 1, workflow_runs: [.]}' "$GH_STUB_FIXTURES/run.json"
    ;;
  */jobs\?*) cat "$GH_STUB_FIXTURES/jobs.json" ;;
  */commits/*/pulls) jq -c '[{number, head}]' "$GH_STUB_FIXTURES/pull.json" ;;
  */pulls/*/files*) cat "$GH_STUB_FIXTURES/pull-files.json" ;;
  */pulls/*) cat "$GH_STUB_FIXTURES/pull.json" ;;
  *)
    echo "gh: Not Found (HTTP 404)" >&2
    exit 1
    ;;
esac
STUB
  chmod +x "$TEST_ROOT/bin/gh"
  export PATH="$TEST_ROOT/bin:$PATH"
  export AUTOMOBILE_DATA_DIR="$TEST_ROOT/data"
  export AUTOMOBILE_LOG_DIR="$TEST_ROOT/logs"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "--help prints usage and exits 0" {
  run bun "$SCRIPT" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"--since"* ]]
  [[ "$output" == *"Exit codes"* ]]
}

@test "unknown flag exits 2 with usage" {
  run bun "$SCRIPT" --bogus
  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "invalid --pr-type exits 2" {
  run bun "$SCRIPT" --pr-type nonsense
  [ "$status" -eq 2 ]
  [[ "$output" == *"--pr-type must be one of"* ]]
}

@test "--since later than --until exits 2" {
  run bun "$SCRIPT" --since 2026-10-10T00:00:00Z --until 2026-10-09T00:00:00Z
  [ "$status" -eq 2 ]
}

@test "--cache-dir outside scratch/ and the temp dir exits 2 and writes nothing" {
  run bun "$SCRIPT" --cache-dir /var/empty/ttg-cache
  [ "$status" -eq 2 ]
  [[ "$output" == *"outside the repo's scratch/"* ]]
  [ ! -s "$GH_STUB_LOG" ]
}

@test "fetches through gh, prints Markdown tables and only issues GET requests" {
  run bun "$SCRIPT" --since 3d --repo kaeawc/auto-mobile --cache-dir "$TEST_ROOT/cache"
  [ "$status" -eq 0 ]
  [[ "$output" == *"## Time to green"* ]]
  [[ "$output" == *"## Peak runner concurrency"* ]]
  [[ "$output" == *"Required checks (from the ruleset): 22"* ]]
  run grep -E -- '(-X|--method|-f |-F |--field|--input)' "$GH_STUB_LOG"
  [ "$status" -ne 0 ]
  run grep -c "rulesets" "$GH_STUB_LOG"
  [ "$output" -ge 2 ]
}

@test "--json emits parseable JSON with the headline sections" {
  run bash -c 'bun "$0" --since 3d --repo kaeawc/auto-mobile --json --cache-dir "$1" 2> /dev/null' "$SCRIPT" "$TEST_ROOT/cache"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.counts.shas and .timeToGreenMs and .firstAttempt and .concurrency.selfHostedMac.cap == 3 and .concurrency.githubHosted.cap == 40' > /dev/null
}

@test "--save-bundle then --from-bundle aggregates offline without calling gh" {
  run bun "$SCRIPT" --since 3d --repo kaeawc/auto-mobile --save-bundle "$TEST_ROOT/bundle.json" --cache-dir "$TEST_ROOT/cache"
  [ "$status" -eq 0 ]
  : > "$GH_STUB_LOG"
  run bun "$SCRIPT" --from-bundle "$TEST_ROOT/bundle.json" --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.requiredChecks | length == 22' > /dev/null
  [ ! -s "$GH_STUB_LOG" ]
}

@test "a second run with the same --cache-dir makes fewer API calls" {
  run bun "$SCRIPT" --since 3d --repo kaeawc/auto-mobile --cache-dir "$TEST_ROOT/cache"
  [ "$status" -eq 0 ]
  first_calls="$(grep -c . "$GH_STUB_LOG")"
  : > "$GH_STUB_LOG"
  run bun "$SCRIPT" --since 3d --repo kaeawc/auto-mobile --cache-dir "$TEST_ROOT/cache"
  [ "$status" -eq 0 ]
  second_calls="$(grep -c . "$GH_STUB_LOG")"
  [ "$second_calls" -lt "$first_calls" ]
}

@test "a rate limit exits 4 and says how to resume" {
  GH_STUB_MODE=ratelimit run bun "$SCRIPT" --since 3d --repo kaeawc/auto-mobile --cache-dir "$TEST_ROOT/cache"
  [ "$status" -eq 4 ]
  [[ "$output" == *"rerun with the same --cache-dir"* ]]
}

@test "--max-api-calls exhausted exits 4" {
  run bun "$SCRIPT" --since 3d --repo kaeawc/auto-mobile --max-api-calls 3 --cache-dir "$TEST_ROOT/cache"
  [ "$status" -eq 4 ]
  [[ "$output" == *"budget"* ]]
}

@test "an API failure exits 3" {
  cat > "$TEST_ROOT/bin/gh" << 'STUB'
#!/usr/bin/env bash
echo "gh: Not Found (HTTP 404)" >&2
exit 1
STUB
  run bun "$SCRIPT" --since 3d --repo kaeawc/auto-mobile --cache-dir "$TEST_ROOT/cache"
  [ "$status" -eq 3 ]
}
