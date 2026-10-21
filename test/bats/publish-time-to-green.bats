#!/usr/bin/env bats
# Publish complete reports only (#11582). Real Bun/tool, captured gh responses;
# the stub ignores the created filter, as in ci-time-to-green.bats.
REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/publish-time-to-green.sh"
FIXTURES="$REPO_ROOT/test/fixtures/ci-time-to-green"
WF="$REPO_ROOT/.github/workflows/ci-time-to-green-report.yml"

setup() {
  TEST_ROOT="$(mktemp -d)"
  mkdir -p "$TEST_ROOT/bin"
  export TTG_SINCE=3d
  export TTG_MAX_API_CALLS=600
  export TTG_OUT_DIR="$TEST_ROOT/out"
  export GITHUB_STEP_SUMMARY="$TEST_ROOT/summary.md"
  export GITHUB_REPOSITORY=kaeawc/auto-mobile
  unset GH_STUB_MODE TTG_BUN
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
  */commits/*/statuses*) cat "$GH_STUB_FIXTURES/commit-statuses.json" ;;
  */pulls\?*) cat "$GH_STUB_FIXTURES/pulls-list.json" ;;
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
  export TMPDIR="$TEST_ROOT"
  export AUTOMOBILE_DATA_DIR="$TEST_ROOT/data"
  export AUTOMOBILE_LOG_DIR="$TEST_ROOT/logs"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "success publishes three files and a PR-only summary from any cwd" {
  cd "$TEST_ROOT"
  printf 'Existing summary\n' > "$GITHUB_STEP_SUMMARY"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"## Time to green"* ]]
  [ "$(find "$TTG_OUT_DIR" -type f | wc -l | tr -d ' ')" -eq 3 ]
  [ -s "$TTG_OUT_DIR/time-to-green-bundle.json" ]
  grep -Fq 'pull_request runs only' "$TTG_OUT_DIR/time-to-green.md"
  grep -Fq 'Existing summary' "$GITHUB_STEP_SUMMARY"
  grep -Eq '^## PR time-to-green report: 3d, pull_request runs only, generated [0-9T:Z-]+$' "$GITHUB_STEP_SUMMARY"
  grep -Fq '## Time to green' "$GITHUB_STEP_SUMMARY"
  jq -e '.concurrency.prRunsOnly == true' "$TTG_OUT_DIR/time-to-green.json"
  # The bundle renders offline, so its call count matches the only fetch.
  jq -e '.meta.prRunsOnly == true' "$TTG_OUT_DIR/time-to-green-bundle.json"
  [ "$(find "$TEST_ROOT" -maxdepth 1 -type d -name 'ci-time-to-green.*' | wc -l | tr -d ' ')" -eq 0 ]
  run grep -E -- '(-X|--method|-f |-F |--field|--input|^issue( |$)|^pr( |$))' "$GH_STUB_LOG"
  [ "$status" -eq 1 ]
}

@test "rate limit exits 4 and removes partial and stale reports" {
  mkdir -p "$TTG_OUT_DIR"
  touch "$TTG_OUT_DIR/time-to-green.json" "$TTG_OUT_DIR/time-to-green-bundle.json"
  GH_STUB_MODE=ratelimit run bash "$SCRIPT"
  [ "$status" -eq 4 ]
  [[ "$output" == *"::error::"* ]]
  [ -z "$(ls -A "$TTG_OUT_DIR")" ]
  grep -Fq 'Exit code 4: stopped on the API call budget or a rate limit' "$GITHUB_STEP_SUMMARY"
  grep -Fq 'no report was published for this window' "$GITHUB_STEP_SUMMARY"
}

@test "API budget stop exits 4 without published files" {
  TTG_MAX_API_CALLS=3 run bash "$SCRIPT"
  [ "$status" -eq 4 ]
  [ -z "$(ls -A "$TTG_OUT_DIR")" ]
  grep -Fq 'no report was published for this window' "$GITHUB_STEP_SUMMARY"
}

@test "invalid window exits 2 before any gh call" {
  TTG_SINCE='1d; rm -rf x' run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"TTG_SINCE"* ]]
  [ ! -s "$GH_STUB_LOG" ]
}

@test "invalid API budgets exit 2 before any gh call" {
  for budget in 0 -1 1001 1.5 nope 999999999999999999999999999; do
    TTG_MAX_API_CALLS="$budget" run bash "$SCRIPT"
    [ "$status" -eq 2 ]
    [[ "$output" == *"TTG_MAX_API_CALLS"* ]]
    [ ! -s "$GH_STUB_LOG" ]
  done
}

@test "success works without a summary and defaults output to RUNNER_TEMP" {
  unset GITHUB_STEP_SUMMARY TTG_OUT_DIR GITHUB_REPOSITORY
  export RUNNER_TEMP="$TEST_ROOT/runner"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -s "$RUNNER_TEMP/ci-time-to-green-report/time-to-green.md" ]
  jq -e '.concurrency.prRunsOnly == true' "$RUNNER_TEMP/ci-time-to-green-report/time-to-green.json"
}

@test "API failure exits 3 with its meaning and no report" {
  cat > "$TEST_ROOT/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo 'gh: Not Found (HTTP 404)' >&2
exit 1
STUB
  run bash "$SCRIPT"
  [ "$status" -eq 3 ]
  [ -z "$(ls -A "$TTG_OUT_DIR")" ]
  grep -Fq 'Exit code 3: GitHub API failure' "$GITHUB_STEP_SUMMARY"
}

@test "empty Markdown on exit zero is an unexpected failure" {
  export TTG_BUN="$TEST_ROOT/bin/empty-bun"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TTG_BUN"
  chmod +x "$TTG_BUN"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [ -z "$(ls -A "$TTG_OUT_DIR")" ]
  grep -Fq 'Exit code 1: unexpected failure' "$GITHUB_STEP_SUMMARY"
}

@test "offline tool failure removes the successful Markdown too" {
  export REAL_BUN="$(command -v bun)"
  export TTG_BUN="$TEST_ROOT/bin/offline-failure-bun"
  cat > "$TTG_BUN" <<'STUB'
#!/usr/bin/env bash
if [[ "$2" == '--from-bundle' ]]; then
  echo 'partial JSON'
  exit 1
fi
exec "$REAL_BUN" "$@"
STUB
  chmod +x "$TTG_BUN"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [ -z "$(ls -A "$TTG_OUT_DIR")" ]
  grep -Fq 'no report was published for this window' "$GITHUB_STEP_SUMMARY"
}

wiring_requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo 'yq is required in CI to verify time-to-green workflow wiring' >&2
    return 1
  fi
  skip 'yq not installed'
}

@test "workflow schedules daily and permits a manual window" {
  wiring_requires_yq
  run yq -r '.on.schedule[0].cron' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" = '37 4 * * *' ]
  run yq -r '.on.workflow_dispatch.inputs.since | [.type, .default, .required] | @tsv' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" = $'string\t24h\tfalse' ]
}

@test "workflow uses read-only permissions and passes the window only through env" {
  wiring_requires_yq
  run yq -r '.jobs.report.permissions | to_entries | map(.value) | unique | .[]' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" = read ]
  run yq -r '.jobs.report.steps[] | select(.name == "Publish time-to-green report") | .run' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" = 'bash scripts/ci/publish-time-to-green.sh' ]
  run yq -r '.jobs.report.steps[] | select(.name == "Publish time-to-green report") | .env.TTG_SINCE' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" = "\${{ inputs.since || '24h' }}" ]
}

@test "artifact upload is unconditional with 90-day retention" {
  wiring_requires_yq
  run yq -r '.jobs.report.steps[] | select(.uses == "actions/upload-artifact@v6") | [.if, .with.name, .with.path, .with."if-no-files-found", .with."retention-days"] | @tsv' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" = $'always()\tci-time-to-green-report\t${{ runner.temp }}/ci-time-to-green-report/\tignore\t90' ]
}
