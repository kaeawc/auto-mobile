#!/usr/bin/env bats
# Tests for scripts/ci/pr-failing-job-logs.sh (issue #4119).

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ci/pr-failing-job-logs.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  STUB_DIR="${TEST_ROOT}/bin"
  mkdir -p "$STUB_DIR" "${TEST_ROOT}/scratch"
  cd "$TEST_ROOT"

  cat >"${STUB_DIR}/gh" <<'SHIM'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "${GH_CALLS:?}"

case "$*" in
  "api --help"|"api "*"--help"*)
    # Feature detection: gh >= 2.101.0 lists --allow-escape-sequences; older gh
    # does not. GH_ALLOW_ESCAPE selects which client this fake emulates.
    if [[ "${GH_ALLOW_ESCAPE:-supported}" == "supported" ]]; then
      printf '%s\n' '      --allow-escape-sequences   Allow escape sequences in the output'
    else
      printf '%s\n' '      --paginate   Make additional HTTP requests to fetch all pages'
    fi
    ;;
  "pr checks "*)
    case "${GH_SCENARIO:?}" in
      no-fail) printf '%s\n' '[{"name":"Build","state":"SUCCESS","bucket":"pass","link":"https://github.com/o/r/actions/runs/100"},{"name":"Skipped","state":"SKIPPED","bucket":"skipping","link":"https://github.com/o/r/actions/runs/200"},{"name":"Cancelled","state":"CANCELLED","bucket":"cancel","link":"https://github.com/o/r/actions/runs/300"}]' ;;
      fail-log|fail-live) printf '%s\n' '[{"name":"Failing","state":"FAILURE","bucket":"fail","link":"https://github.com/o/r/actions/runs/123"},{"name":"Skipped","state":"SKIPPED","bucket":"skipping","link":"https://github.com/o/r/actions/runs/200"},{"name":"Cancelled","state":"CANCELLED","bucket":"cancel","link":"https://github.com/o/r/actions/runs/300"}]' ;;
      fail-check-run) printf '%s\n' '[{"name":"JUnit report","state":"FAILURE","bucket":"fail","link":"https://github.com/o/r/runs/456"}]' ;;
    esac
    ;;
  "api repos/kaeawc/auto-mobile/actions/runs/123/jobs "*)
    case "${GH_SCENARIO:?}" in
      fail-log) printf '%s\n' $'77\tFast failing job' ;;
      fail-live) printf '%s\n' $'77\tStill running failure' ;;
    esac
    ;;
  *"actions/jobs/77/logs")
    # Enforce the flag contract for the emulated client: a supported gh must be
    # given the flag; an unsupported gh must NOT be (it errors on the unknown
    # flag). This makes the script's feature detection load-bearing.
    if [[ "${GH_ALLOW_ESCAPE:-supported}" == "supported" ]]; then
      if [[ "$*" != *"--allow-escape-sequences"* ]]; then
        echo "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway" >&2
        exit 1
      fi
    elif [[ "$*" == *"--allow-escape-sequences"* ]]; then
      echo "unknown flag: --allow-escape-sequences" >&2
      exit 1
    fi
    case "${GH_SCENARIO:?}" in
      fail-log) printf '%s\n' '##[error] actual failure detail' ;;
      fail-live) printf '%s\n' 'BlobNotFound' >&2; exit 1 ;;
    esac
    ;;
  "api repos/kaeawc/auto-mobile/actions/jobs/77 "*)
    printf '%s\n' $'  step 2\tin_progress\t-\tCompile'
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
SHIM
  chmod +x "${STUB_DIR}/gh"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

run_script() {
  run env \
    PATH="${STUB_DIR}:/opt/homebrew/bin:/usr/bin:/bin" \
    GH_CALLS="${TEST_ROOT}/gh-calls" \
    GH_SCENARIO="$1" \
    GH_ALLOW_ESCAPE="${2:-supported}" \
    bash "$SCRIPT" 42
}

@test "pursues only failed check buckets and exits non-zero" {
  run_script fail-log

  [ "$status" -ne 0 ]
  [[ "$output" == *"actual failure detail"* ]]
  [ -f "scratch/job-77.log" ]
  grep -q 'actions/runs/123/jobs' "${TEST_ROOT}/gh-calls"
  ! grep -q 'actions/runs/200/jobs\|actions/runs/300/jobs' "${TEST_ROOT}/gh-calls"
  ! grep -q 'jobs/88' "${TEST_ROOT}/gh-calls"
}

@test "reads a job log on gh < 2.101.0 that lacks --allow-escape-sequences" {
  # Feature detection must omit the flag for an older gh; otherwise the log read
  # fails there and the script falls through to the per-step fallback.
  run_script fail-log unsupported

  [ "$status" -ne 0 ]
  [[ "$output" == *"actual failure detail"* ]]
  [ -f "scratch/job-77.log" ]
}

@test "a missing live-job log falls back to per-step status" {
  run_script fail-live

  [ "$status" -ne 0 ]
  [[ "$output" == *$'step 2\tin_progress\t-\tCompile'* ]]
  grep -q 'actions/jobs/77/logs' "${TEST_ROOT}/gh-calls"
  grep -q 'actions/jobs/77 --jq' "${TEST_ROOT}/gh-calls"
}

@test "returns zero when checks have no failures" {
  run_script no-fail

  [ "$status" -eq 0 ]
  [[ "$output" == *"No failures"* ]]
  ! grep -q 'actions/runs/' "${TEST_ROOT}/gh-calls"
}

@test "reports a failed generic check-run link without querying it as an Actions run" {
  run_script fail-check-run

  [ "$status" -ne 0 ]
  [[ "$output" == *"Unable to retrieve job logs for failed non-workflow check link(s):"* ]]
  [[ "$output" == *"https://github.com/o/r/runs/456"* ]]
  ! grep -q 'actions/runs/456/jobs' "${TEST_ROOT}/gh-calls"
}

@test "uses BSD-compatible extended grep rather than GNU grep -P" {
  run grep -nE 'grep -oE' "$SCRIPT"
  [ "$status" -eq 0 ]

  run grep -nE '^[[:space:]]*[^#].*grep[[:space:]]+-oP' "$SCRIPT"
  [ "$status" -ne 0 ]
}
