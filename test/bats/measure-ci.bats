#!/usr/bin/env bats
#
# Tests for scripts/ci/measure-ci.sh (issue #4122).
#
# Every test drives the AGGREGATION layer through --from-file with a fixture
# bundle, so nothing here touches the network or the GitHub API. The fetch layer
# is deliberately separable for exactly this reason.

# Absolute path: several bats files in this directory `cd` inside a test body
# without a subshell, and they sort before this one. A relative SCRIPT path then
# resolves against whatever cwd they left behind -- the suite passes in isolation
# and fails in the full run.
SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ci/measure-ci.sh"

# Assert the run succeeded, and on failure surface the script's status AND output.
# Bare `assert_ok` reports only the assertion line, which made a CI-only
# failure undiagnosable from the logs (the whole point of #4077).
assert_ok() {
  if [ "$status" -ne 0 ]; then
    echo "--- command failed: status=$status ---" >&2
    echo "$output" >&2
    echo "--- env: PWD=$PWD jq=$(command -v jq || echo MISSING) bash=$BASH_VERSION ---" >&2
    return 1
  fi
}

setup() {
  TEST_ROOT="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

# --------------------------------------------------------------------------
# Fixture builders
# --------------------------------------------------------------------------

# mk_step NAME NUMBER CONCLUSION START_OFFSET_S DURATION_S
# Emits one step object; timestamps are derived from a fixed epoch so durations
# are exact.
mk_step() {
  jq -n --arg name "$1" --argjson number "$2" --arg conclusion "$3" \
    --argjson start "$4" --argjson dur "$5" '
    (1767225600 + $start) as $s
    | { name: $name, number: $number, status: "completed", conclusion: $conclusion,
        started_at: (if $conclusion == "skipped" then null else ($s | todateiso8601) end),
        completed_at: (if $conclusion == "skipped" then null else ($s + $dur | todateiso8601) end) }'
}

# mk_bundle < runs-json  -> a full bundle with default meta
mk_bundle() {
  jq -n --argjson runs "$(cat)" '
    { meta: { repo: "o/r", workflow: "Pull Request", branch: null, limit: 10,
              sentinel: null, fetched_at: "2026-07-21T00:00:00Z" },
      runs: $runs }'
}

# A bundle of N runs, each with one job "iOS" containing one step "Boot" whose
# duration is taken from the passed JSON array. Used to pin the percentile math.
bundle_from_durations() {
  jq -n --argjson d "$1" '
    [ range(0; $d | length) as $i
      | { id: (100 + $i), number: $i, head_sha: "sha\($i)", head_branch: "b",
          event: "pull_request", status: "completed", conclusion: "success",
          run_attempt: 1,
          created_at: (1767225600 + $i * 3600 | todateiso8601),
          updated_at: (1767225600 + $i * 3600 | todateiso8601),
          jobs: [ { id: (1000 + $i), name: "iOS", run_attempt: 1,
                    status: "completed", conclusion: "success",
                    started_at: (1767225600 | todateiso8601),
                    completed_at: (1767225600 + $d[$i] | todateiso8601),
                    sentinel: null,
                    steps: [ { name: "Boot", number: 1, status: "completed",
                               conclusion: "success",
                               started_at: (1767225600 | todateiso8601),
                               completed_at: (1767225600 + $d[$i] | todateiso8601) } ] } ] } ]
  ' | mk_bundle
}

# --------------------------------------------------------------------------
# CLI contract
# --------------------------------------------------------------------------

@test "--help prints usage and exits 0" {
  run bash "$SCRIPT" --help
  assert_ok
  [[ "$output" == *"--from-file"* ]]
  [[ "$output" == *"--max-runs"* ]]
}

@test "rejects an unknown argument" {
  run bash "$SCRIPT" --nope
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown argument"* ]]
}

@test "fails loudly when --limit exceeds --max-runs instead of truncating" {
  run bash "$SCRIPT" --limit 500 --max-runs 100
  [ "$status" -ne 0 ]
  [[ "$output" == *"exceeds --max-runs"* ]]
  [[ "$output" == *"API calls"* ]]
}

@test "rejects a non-numeric --limit" {
  run bash "$SCRIPT" --limit abc
  [ "$status" -ne 0 ]
  [[ "$output" == *"positive integer"* ]]
}

@test "--from-file and --fetch-only are mutually exclusive" {
  run bash "$SCRIPT" --from-file /dev/null --fetch-only
  [ "$status" -ne 0 ]
  [[ "$output" == *"mutually exclusive"* ]]
}

@test "errors when the bundle file is missing" {
  run bash "$SCRIPT" --from-file "${TEST_ROOT}/nope.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not found"* ]]
}

@test "errors when the bundle is not a bundle" {
  echo '{"nope":1}' > "${TEST_ROOT}/bad.json"
  run bash "$SCRIPT" --from-file "${TEST_ROOT}/bad.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"runs"* ]]
}

@test "aggregation needs no network: works with gh unavailable" {
  # A shim that fails on any gh invocation proves --from-file never shells out.
  mkdir -p "${TEST_ROOT}/bin"
  printf '#!/bin/sh\necho "gh was called" >&2\nexit 99\n' > "${TEST_ROOT}/bin/gh"
  chmod +x "${TEST_ROOT}/bin/gh"
  bundle_from_durations '[10,20,30]' > "${TEST_ROOT}/b.json"
  run env PATH="${TEST_ROOT}/bin:$PATH" bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 1
  assert_ok
  [[ "$output" != *"gh was called"* ]]
}

@test "reads a bundle from stdin with --from-file -" {
  bundle_from_durations '[10,20,30]' > "${TEST_ROOT}/b.json"
  run bash -c "cat '${TEST_ROOT}/b.json' | bash '$SCRIPT' --from-file - --min-samples 1"
  assert_ok
  [[ "$output" == *"iOS / Boot #1"* ]]
}

# --------------------------------------------------------------------------
# 1. Per-job failure rate
# --------------------------------------------------------------------------

@test "tallies per-job outcomes and ranks by failure rate" {
  jq -n '
    def job($name; $conc): { id: 1, name: $name, run_attempt: 1, status: "completed",
      conclusion: $conc, started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:01:00Z", sentinel: null, steps: [] };
    [ { id: 1, number: 1, head_sha: "a", head_branch: "b", event: "pull_request",
        status: "completed", conclusion: "failure", run_attempt: 1,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:01:00Z",
        jobs: [ job("Flaky"; "failure"), job("Solid"; "success"),
                job("Never"; "skipped") ] },
      { id: 2, number: 2, head_sha: "c", head_branch: "b", event: "pull_request",
        status: "completed", conclusion: "success", run_attempt: 1,
        created_at: "2026-01-01T01:00:00Z", updated_at: "2026-01-01T01:01:00Z",
        jobs: [ job("Flaky"; "success"), job("Solid"; "success"),
                job("Never"; "skipped") ] } ]' | mk_bundle > "${TEST_ROOT}/b.json"

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --json
  assert_ok
  [ "$(echo "$output" | jq -r '.jobs[0].job')" = "Flaky" ]
  [ "$(echo "$output" | jq -r '.jobs[0].executed')" = "2" ]
  [ "$(echo "$output" | jq -r '.jobs[0].passed')" = "1" ]
  [ "$(echo "$output" | jq -r '.jobs[0].failed')" = "1" ]
  [ "$(echo "$output" | jq -r '.jobs[0].failure_rate')" = "0.5" ]
  # Skipped runs are excluded from the executed denominator, so a job that never
  # ran does not dilute anyone's rate and reports 0/0 rather than a false 0%.
  [ "$(echo "$output" | jq -r '.jobs[] | select(.job == "Never") | .executed')" = "0" ]
  [ "$(echo "$output" | jq -r '.jobs[] | select(.job == "Never") | .skipped')" = "2" ]
  [ "$(echo "$output" | jq -r '.jobs[] | select(.job == "Solid") | .failure_rate')" = "0" ]
}

@test "human summary prints the per-job table" {
  bundle_from_durations '[10,20,30]' > "${TEST_ROOT}/b.json"
  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 1
  assert_ok
  [[ "$output" == *"Per-job outcomes"* ]]
  [[ "$output" == *"iOS"* ]]
}

# --------------------------------------------------------------------------
# 2. Percentile math (pinned)
# --------------------------------------------------------------------------

@test "percentiles use nearest-rank over a known 10-sample input" {
  # Durations 10..100. Nearest-rank: idx = ceil(p/100 * 10).
  #   p50 -> 5th  = 50    p90 -> 9th  = 90    p95 -> ceil(9.5)=10th = 100
  # An interpolating implementation would give 91 / 95.5 here, and an
  # off-by-one index would give 80 / 90 — both fail this assertion.
  bundle_from_durations '[10,20,30,40,50,60,70,80,90,100]' > "${TEST_ROOT}/b.json"
  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --json
  assert_ok
  [ "$(echo "$output" | jq -r '.steps[0].samples')" = "10" ]
  [ "$(echo "$output" | jq -r '.steps[0].min')" = "10" ]
  [ "$(echo "$output" | jq -r '.steps[0].median')" = "50" ]
  [ "$(echo "$output" | jq -r '.steps[0].p90')" = "90" ]
  [ "$(echo "$output" | jq -r '.steps[0].p95')" = "100" ]
  [ "$(echo "$output" | jq -r '.steps[0].max')" = "100" ]
}

@test "percentiles are order-independent (input sorted before ranking)" {
  bundle_from_durations '[100,30,70,10,90,50,20,80,40,60]' > "${TEST_ROOT}/b.json"
  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --json
  assert_ok
  [ "$(echo "$output" | jq -r '.steps[0].median')" = "50" ]
  [ "$(echo "$output" | jq -r '.steps[0].p90')" = "90" ]
  [ "$(echo "$output" | jq -r '.steps[0].p95')" = "100" ]
}

@test "a single sample collapses every percentile to that value" {
  bundle_from_durations '[42]' > "${TEST_ROOT}/b.json"
  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 1 --json
  assert_ok
  [ "$(echo "$output" | jq -r '.steps[0].min')" = "42" ]
  [ "$(echo "$output" | jq -r '.steps[0].p95')" = "42" ]
  [ "$(echo "$output" | jq -r '.steps[0].max')" = "42" ]
}

# --------------------------------------------------------------------------
# 3. Repeated-step ORDINAL preservation
# --------------------------------------------------------------------------

@test "repeated same-named steps are reported separately by ordinal" {
  # Three "Boot" steps in one job with distinct durations. A group-by-name
  # implementation collapses these into one row and destroys the "third boot
  # owns the tail" signal that justified dropping the Xcode 26.2 leg.
  jq -n --argjson s1 "$(mk_step Boot 1 success 0 20)" \
    --argjson s2 "$(mk_step Boot 2 success 30 90)" \
    --argjson s3 "$(mk_step Boot 3 success 150 400)" '
    [ { id: 1, number: 1, head_sha: "a", head_branch: "b", event: "pull_request",
        status: "completed", conclusion: "success", run_attempt: 1,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T01:00:00Z",
        jobs: [ { id: 9, name: "iOS", run_attempt: 1, status: "completed",
                  conclusion: "success", started_at: "2026-01-01T00:00:00Z",
                  completed_at: "2026-01-01T01:00:00Z", sentinel: null,
                  steps: [ $s1, $s2, $s3 ] } ] } ]' | mk_bundle > "${TEST_ROOT}/b.json"

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 1 --json
  assert_ok
  [ "$(echo "$output" | jq '[.steps[] | select(.step == "Boot")] | length')" = "3" ]
  [ "$(echo "$output" | jq -r '.steps[] | select(.ordinal == 1) | .max')" = "20" ]
  [ "$(echo "$output" | jq -r '.steps[] | select(.ordinal == 2) | .max')" = "90" ]
  [ "$(echo "$output" | jq -r '.steps[] | select(.ordinal == 3) | .max')" = "400" ]
  # The tail belongs to boot #3 and nothing else: ranking is by p95.
  [ "$(echo "$output" | jq -r '.steps[0].ordinal')" = "3" ]
}

@test "human summary labels repeated steps with #ordinal" {
  jq -n --argjson s1 "$(mk_step Boot 1 success 0 20)" \
    --argjson s2 "$(mk_step Boot 2 success 30 400)" '
    [ { id: 1, number: 1, head_sha: "a", head_branch: "b", event: "pull_request",
        status: "completed", conclusion: "success", run_attempt: 1,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T01:00:00Z",
        jobs: [ { id: 9, name: "iOS", run_attempt: 1, status: "completed",
                  conclusion: "success", started_at: "2026-01-01T00:00:00Z",
                  completed_at: "2026-01-01T01:00:00Z", sentinel: null,
                  steps: [ $s1, $s2 ] } ] } ]' | mk_bundle > "${TEST_ROOT}/b.json"

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 1
  assert_ok
  [[ "$output" == *"iOS / Boot #1"* ]]
  [[ "$output" == *"iOS / Boot #2"* ]]
}

@test "ordinal is positional, not the step number: an inserted step does not renumber boots" {
  # Run 1: Boot, Boot          (numbers 1,2)
  # Run 2: Setup, Boot, Boot   (numbers 1,2,3) — every Boot number shifts by one.
  # Keying on .number would split each boot into two one-sample buckets.
  jq -n \
    --argjson a1 "$(mk_step Boot 1 success 0 10)" \
    --argjson a2 "$(mk_step Boot 2 success 20 300)" \
    --argjson b0 "$(mk_step Setup 1 success 0 5)" \
    --argjson b1 "$(mk_step Boot 2 success 10 12)" \
    --argjson b2 "$(mk_step Boot 3 success 30 310)" '
    def run($id; $steps): { id: $id, number: $id, head_sha: "sha\($id)",
      head_branch: "b", event: "pull_request", status: "completed",
      conclusion: "success", run_attempt: 1,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T01:00:00Z",
      jobs: [ { id: $id, name: "iOS", run_attempt: 1, status: "completed",
                conclusion: "success", started_at: "2026-01-01T00:00:00Z",
                completed_at: "2026-01-01T01:00:00Z", sentinel: null,
                steps: $steps } ] };
    [ run(1; [ $a1, $a2 ]), run(2; [ $b0, $b1, $b2 ]) ]' | mk_bundle > "${TEST_ROOT}/b.json"

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 2 --json
  assert_ok
  # Both boots pair up across runs: two buckets of two samples each.
  [ "$(echo "$output" | jq '[.steps[] | select(.step == "Boot")] | length')" = "2" ]
  [ "$(echo "$output" | jq -r '.steps[] | select(.step == "Boot" and .ordinal == 1) | .samples')" = "2" ]
  [ "$(echo "$output" | jq -r '.steps[] | select(.step == "Boot" and .ordinal == 1) | .max')" = "12" ]
  [ "$(echo "$output" | jq -r '.steps[] | select(.step == "Boot" and .ordinal == 2) | .max')" = "310" ]
}

@test "skipped steps are excluded from the duration distribution" {
  jq -n --argjson s1 "$(mk_step Boot 1 success 0 20)" \
    --argjson s2 "$(mk_step Boot 2 skipped 0 0)" '
    [ { id: 1, number: 1, head_sha: "a", head_branch: "b", event: "pull_request",
        status: "completed", conclusion: "success", run_attempt: 1,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T01:00:00Z",
        jobs: [ { id: 9, name: "iOS", run_attempt: 1, status: "completed",
                  conclusion: "success", started_at: "2026-01-01T00:00:00Z",
                  completed_at: "2026-01-01T01:00:00Z", sentinel: null,
                  steps: [ $s1, $s2 ] } ] } ]' | mk_bundle > "${TEST_ROOT}/b.json"

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 1 --json
  assert_ok
  [ "$(echo "$output" | jq '[.steps[] | select(.step == "Boot")] | length')" = "1" ]
  [ "$(echo "$output" | jq -r '.steps[0].ordinal')" = "1" ]
}

# --------------------------------------------------------------------------
# 4. Rerun-success rate
# --------------------------------------------------------------------------

@test "counts a job that failed then passed on a later attempt of the same SHA" {
  jq -n '
    def job($attempt; $conc): { id: (10 + $attempt), name: "iOS",
      run_attempt: $attempt, status: "completed", conclusion: $conc,
      started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:10:00Z",
      sentinel: null, steps: [] };
    [ { id: 1, number: 1, head_sha: "flaky", head_branch: "b",
        event: "pull_request", status: "completed", conclusion: "success",
        run_attempt: 2, created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T01:00:00Z",
        jobs: [ job(1; "failure"), job(2; "success") ] } ]' | mk_bundle > "${TEST_ROOT}/b.json"

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --json
  assert_ok
  [ "$(echo "$output" | jq -r '.reruns.retried_units')" = "1" ]
  [ "$(echo "$output" | jq -r '.reruns.rerun_passed')" = "1" ]
  [ "$(echo "$output" | jq -r '.reruns.rerun_success_rate')" = "1" ]
  [ "$(echo "$output" | jq -r '.reruns.by_job[0].job')" = "iOS" ]
  [ "$(echo "$output" | jq -r '.reruns.units[0].sha')" = "flaky" ]
}

@test "a job that fails on every attempt is retried but not a rerun-success" {
  jq -n '
    def job($attempt; $conc): { id: (10 + $attempt), name: "iOS",
      run_attempt: $attempt, status: "completed", conclusion: $conc,
      started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:10:00Z",
      sentinel: null, steps: [] };
    [ { id: 1, number: 1, head_sha: "broken", head_branch: "b",
        event: "pull_request", status: "completed", conclusion: "failure",
        run_attempt: 2, created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T01:00:00Z",
        jobs: [ job(1; "failure"), job(2; "failure") ] } ]' | mk_bundle > "${TEST_ROOT}/b.json"

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --json
  assert_ok
  [ "$(echo "$output" | jq -r '.reruns.retried_units')" = "1" ]
  [ "$(echo "$output" | jq -r '.reruns.rerun_passed')" = "0" ]
  [ "$(echo "$output" | jq -r '.reruns.rerun_success_rate')" = "0" ]
}

@test "a single-attempt failure is not a rerun unit" {
  jq -n '
    [ { id: 1, number: 1, head_sha: "x", head_branch: "b", event: "pull_request",
        status: "completed", conclusion: "failure", run_attempt: 1,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T01:00:00Z",
        jobs: [ { id: 9, name: "iOS", run_attempt: 1, status: "completed",
                  conclusion: "failure", started_at: "2026-01-01T00:00:00Z",
                  completed_at: "2026-01-01T00:10:00Z", sentinel: null,
                  steps: [] } ] } ]' | mk_bundle > "${TEST_ROOT}/b.json"

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --json
  assert_ok
  [ "$(echo "$output" | jq -r '.reruns.retried_units')" = "0" ]
  [ "$(echo "$output" | jq -r '.reruns.rerun_success_rate')" = "null" ]
}

# --------------------------------------------------------------------------
# Filters, JSON shape, sentinel
# --------------------------------------------------------------------------

@test "--min-samples hides thin step buckets" {
  bundle_from_durations '[10]' > "${TEST_ROOT}/b.json"
  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 3 --json
  assert_ok
  [ "$(echo "$output" | jq '.steps | length')" = "0" ]
}

@test "--step-filter and --job-filter narrow the report" {
  bundle_from_durations '[10,20,30]' > "${TEST_ROOT}/b.json"
  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 1 --step-filter "Nothing" --json
  assert_ok
  [ "$(echo "$output" | jq '.steps | length')" = "0" ]

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 1 --job-filter "iOS" --json
  assert_ok
  [ "$(echo "$output" | jq '.jobs | length')" = "1" ]
}

@test "--json emits a stable top-level shape for diffing across windows" {
  bundle_from_durations '[10,20,30]' > "${TEST_ROOT}/b.json"
  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --min-samples 1 --json
  assert_ok
  [ "$(echo "$output" | jq -r 'keys | join(",")')" = "jobs,reruns,sentinel,steps,window" ]
  [ "$(echo "$output" | jq -r '.window.runs')" = "3" ]
  [ "$(echo "$output" | jq -r '.window.workflow')" = "Pull Request" ]
  [ "$(echo "$output" | jq -r '.window.step_records')" = "3" ]
  [ "$(echo "$output" | jq -r '.sentinel')" = "null" ]
}

@test "reports the log-sentinel hit rate when the bundle carries sentinel flags" {
  jq -n '
    def job($id; $hit): { id: $id, name: "iOS", run_attempt: 1,
      status: "completed", conclusion: "success",
      started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:10:00Z",
      sentinel: $hit, steps: [] };
    { meta: { repo: "o/r", workflow: "Pull Request", branch: null, limit: 1,
              sentinel: "Status=4294967295", fetched_at: "2026-07-21T00:00:00Z" },
      runs: [ { id: 1, number: 1, head_sha: "a", head_branch: "b",
                event: "pull_request", status: "completed", conclusion: "success",
                run_attempt: 1, created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T01:00:00Z",
                jobs: [ job(1; true), job(2; true), job(3; false) ] } ] }' \
    > "${TEST_ROOT}/b.json"

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json" --json
  assert_ok
  [ "$(echo "$output" | jq -r '.sentinel.observed')" = "3" ]
  [ "$(echo "$output" | jq -r '.sentinel.hits')" = "2" ]
  [ "$(echo "$output" | jq -r '.sentinel.hit_rate')" = "0.667" ]
  [ "$(echo "$output" | jq -r '.sentinel.pattern')" = "Status=4294967295" ]

  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json"
  assert_ok
  [[ "$output" == *"Log sentinel"* ]]
  [[ "$output" == *"2/3 jobs matched"* ]]
}

@test "a cache built without a sentinel is not reused for a sentinel run" {
  # Sentinel flags are computed at fetch time and stored per job. Reusing a cache
  # keyed only on run id + attempt produced a bundle that claimed meta.sentinel
  # while every job's sentinel stayed null -- a measurement that looks valid and
  # is not.
  mkdir -p "${TEST_ROOT}/bin"
  cat > "${TEST_ROOT}/bin/gh" <<'SHIM'
#!/bin/sh
case "$*" in
  *"run list"*) echo '[{"databaseId":111,"headSha":"abc","createdAt":"2026-07-21T00:00:00Z","conclusion":"success","status":"completed","headBranch":"m","displayTitle":"t","attempt":1}]' ;;
  # /logs BEFORE /jobs: the log URL is /actions/jobs/<id>/logs and would
  # otherwise be swallowed by the /jobs pattern, silently serving jobs JSON
  # as the log body.
  *"/logs"*)    echo "line with SENTINEL here" ;;
  *"/jobs"*)    echo '{"jobs":[{"id":9,"name":"iOS","status":"completed","conclusion":"success","run_attempt":1,"started_at":"2026-07-21T00:00:00Z","completed_at":"2026-07-21T00:01:00Z","steps":[]}]}' ;;
  *"repo view"*) echo "o/r" ;;
  *) echo "" ;;
esac
SHIM
  chmod +x "${TEST_ROOT}/bin/gh"

  run env PATH="${TEST_ROOT}/bin:$PATH" bash "$SCRIPT" \
    --cache "${TEST_ROOT}/c.json" --fetch-only --limit 1
  assert_ok

  # stdout only: bats merges stderr into $output, and the fetch layer logs
  # progress there, so parse the bundle from a file rather than $output.
  run env PATH="${TEST_ROOT}/bin:$PATH" bash -c \
    "bash '$SCRIPT' --cache '${TEST_ROOT}/c.json' --sentinel SENTINEL --sentinel-job iOS --fetch-only --limit 1 > '${TEST_ROOT}/b2.json'"
  assert_ok

  # The sentinel must actually have been measured, not inherited as null.
  [ "$(jq -r '.meta.sentinel' "${TEST_ROOT}/b2.json")" = "SENTINEL" ]
  [ "$(jq -r '.runs[0].jobs[0].sentinel' "${TEST_ROOT}/b2.json")" = "true" ]
}

@test "an empty window aggregates without crashing" {
  echo '{"meta":{"repo":"o/r","workflow":"Pull Request","branch":null,"limit":0,"sentinel":null,"fetched_at":"2026-07-21T00:00:00Z"},"runs":[]}' \
    > "${TEST_ROOT}/b.json"
  run bash "$SCRIPT" --from-file "${TEST_ROOT}/b.json"
  assert_ok
  [[ "$output" == *"Runs: 0"* ]]
}
