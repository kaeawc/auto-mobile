#!/usr/bin/env bats

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ci/rerun-contended-runner.sh"

setup() {
  export FIXTURE="$BATS_TEST_TMPDIR/run.json"
  export GH_CALLS="$BATS_TEST_TMPDIR/gh-calls"
  export LOG_CALL_COUNTER="$BATS_TEST_TMPDIR/log-call-counter"
  export JOB_LOG="$BATS_TEST_TMPDIR/job.log"
  export POLL_COUNTER="$BATS_TEST_TMPDIR/poll-counter"
  export LOG_FETCH_RETRY_SLEEP_SECONDS=0
  export RERUN_WAIT_SLEEP_SECONDS=0
  export RERUN_WAIT_TIMEOUT_SECONDS=0
  export FAKE_GH_ALLOW_ESCAPE=supported
  export REPO=kaeawc/auto-mobile
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
  printf '%s\n' 'RUNNER-CONTENDED: unit shard 0 exceeded 720s. Re-run the job to get a fresh runner.' > "$JOB_LOG"
  printf '%s\n' '{"jobs":[{"databaseId":1,"name":"Node Unit Tests (ubuntu-latest)","conclusion":"failure"}]}' > "$FIXTURE"
  cat > "$BATS_TEST_TMPDIR/bin/gh" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_CALLS"
case "$1 $2" in
  'run view')
    if [[ "$*" == *'--json status'* ]]; then
      polls=0
      [[ ! -f "$POLL_COUNTER" ]] || polls="$(cat "$POLL_COUNTER")"
      polls=$((polls + 1))
      printf '%s\n' "$polls" > "$POLL_COUNTER"
      if [[ "$polls" -gt "${FAKE_RUN_IN_PROGRESS_POLLS:-0}" ]]; then echo completed; else echo in_progress; fi
    else
      cat "$FIXTURE"
    fi
    ;;
  'workflow run') [[ "${FAKE_DISPATCH_FAIL:-0}" != 1 ]] || { echo 'HTTP 403: Resource not accessible by integration' >&2; exit 1; } ;;
  'api --help')
    if [[ "$FAKE_GH_ALLOW_ESCAPE" == supported ]]; then
      echo '  --allow-escape-sequences'
    fi
    ;;
  api\ *)
    if [[ "$FAKE_GH_ALLOW_ESCAPE" == supported && "$*" != *--allow-escape-sequences* ]]; then
      exit 1
    elif [[ "$FAKE_GH_ALLOW_ESCAPE" == unsupported && "$*" == *--allow-escape-sequences* ]]; then
      exit 1
    fi
    log_calls=0
    [[ ! -f "$LOG_CALL_COUNTER" ]] || log_calls="$(cat "$LOG_CALL_COUNTER")"
    log_calls=$((log_calls + 1))
    printf '%s\n' "$log_calls" > "$LOG_CALL_COUNTER"
    [[ "$log_calls" -gt "${FAKE_LOG_FAILURES:-0}" ]] || exit 1
    cat "$JOB_LOG"
    ;;
  'run rerun') ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
SHIM
  chmod +x "$BATS_TEST_TMPDIR/bin/gh"
}

assert_no_rerun() {
  [ "$status" -eq 0 ]
  [[ "$output" == *Skipping* ]]
  if [[ -f "$GH_CALLS" ]]; then
    ! grep -F 'run rerun' "$GH_CALLS"
  fi
}

@test "reruns only failed jobs when the sole failure carries the marker" {
  run bash "$SCRIPT" rerun 123 1
  [ "$status" -eq 0 ]
  [[ "$output" == *'Rerunning failed jobs'* ]]
  grep -Fx 'run view 123 -R kaeawc/auto-mobile --json jobs,attempt' "$GH_CALLS"
  grep -Fx 'api --allow-escape-sequences repos/kaeawc/auto-mobile/actions/jobs/1/logs' "$GH_CALLS"
  [ "$(grep -Fc 'run rerun 123 --failed -R kaeawc/auto-mobile' "$GH_CALLS")" -eq 1 ]
}

@test "attempt two does nothing without querying GitHub" {
  run bash "$SCRIPT" rerun 123 2
  assert_no_rerun
  [[ "$output" == *'not the first attempt'* ]]
  [ ! -f "$GH_CALLS" ]
}

@test "another failed job prevents the whole rerun" {
  jq '.jobs += [{databaseId:2,name:"Bun Lint",conclusion:"failure"}]' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  run bash "$SCRIPT" rerun 123 1
  assert_no_rerun
  [[ "$output" == *"'Bun Lint' is not a unit lane"* ]]
}

@test "failed unit job without marker is not retried" {
  echo 'FAIL: a real assertion failure' > "$JOB_LOG"
  run bash "$SCRIPT" rerun 123 1
  assert_no_rerun
  [[ "$output" == *'lacks the contention marker'* ]]
}

@test "Windows build and test job variant is retried" {
  jq '.jobs[0].name = "Node TypeScript Build and Test (windows-latest)"' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  run bash "$SCRIPT" rerun 123 1
  [ "$status" -eq 0 ]
  grep -Fx 'run rerun 123 --failed -R kaeawc/auto-mobile' "$GH_CALLS"
}

@test "every failed unit job must have the marker" {
  jq '.jobs += [{databaseId:2,name:"Node Unit Tests (macos-latest)",conclusion:"failure"}]' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  # Return the real failure for job 2 while keeping contention evidence for job 1.
  sed -i.bak 's/cat "$JOB_LOG"/if [[ "$*" == *jobs\/2\/logs ]]; then echo "FAIL assertion"; else cat "$JOB_LOG"; fi/' "$BATS_TEST_TMPDIR/bin/gh"
  run bash "$SCRIPT" rerun 123 1
  assert_no_rerun
  [[ "$output" == *'macos-latest'* ]]
}

@test "multiple contended unit failures cause one failed-jobs rerun" {
  jq '.jobs += [{databaseId:2,name:"Node Unit Tests (macos-latest)",conclusion:"failure"},{databaseId:3,name:"Bun Lint",conclusion:"success"}]' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  run bash "$SCRIPT" rerun 123 1
  [ "$status" -eq 0 ]
  [ "$(grep -Fc 'run rerun' "$GH_CALLS")" -eq 1 ]
  grep -F 'actions/jobs/2/logs' "$GH_CALLS"
  ! grep -F 'actions/jobs/3/logs' "$GH_CALLS"
}

@test "no failed jobs does nothing" {
  echo '{"jobs":[]}' > "$FIXTURE"
  run bash "$SCRIPT" rerun 123 1
  assert_no_rerun
  [[ "$output" == *'no failed jobs'* ]]
}

@test "older gh clients and repository override are supported" {
  export FAKE_GH_ALLOW_ESCAPE=unsupported
  export REPO=example/project
  run bash "$SCRIPT" rerun 123 1
  [ "$status" -eq 0 ]
  grep -Fx 'api repos/example/project/actions/jobs/1/logs' "$GH_CALLS"
  grep -Fx 'run rerun 123 --failed -R example/project' "$GH_CALLS"
}

@test "zipped job logs are read" {
  mv "$JOB_LOG" "$BATS_TEST_TMPDIR/plain.log"
  zip -jq "$JOB_LOG" "$BATS_TEST_TMPDIR/plain.log"
  run bash "$SCRIPT" rerun 123 1
  [ "$status" -eq 0 ]
  grep -F 'run rerun' "$GH_CALLS"
}

@test "a failed log fetch retries and reruns when the retry succeeds" {
  export FAKE_LOG_FAILURES=1
  run bash "$SCRIPT" rerun 123 1
  [ "$status" -eq 0 ]
  [ "$(cat "$LOG_CALL_COUNTER")" -eq 2 ]
  [ "$(grep -Fc 'actions/jobs/1/logs' "$GH_CALLS")" -eq 2 ]
  grep -F 'run rerun' "$GH_CALLS"
}

@test "two failed log fetches skip successfully without rerunning" {
  export FAKE_LOG_FAILURES=2
  run bash "$SCRIPT" rerun 123 1
  [ "$status" -eq 0 ]
  [[ "$output" == *"could not fetch logs for job 'Node Unit Tests (ubuntu-latest)' (job 1) after 2 attempts"* ]]
  [ "$(cat "$LOG_CALL_COUNTER")" -eq 2 ]
  ! grep -F 'run rerun' "$GH_CALLS"
}

@test "unrelated timed-out jobs prevent rerunning" {
  jq '.jobs += [{databaseId:2,name:"Bun Lint",conclusion:"timed_out"}]' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  run bash "$SCRIPT" rerun 123 1
  assert_no_rerun
}

@test "waits for the run to complete before verifying and rerunning" {
  export RERUN_WAIT_SLEEP_SECONDS=1
  export RERUN_WAIT_TIMEOUT_SECONDS=5
  export FAKE_RUN_IN_PROGRESS_POLLS=2
  sleep() { :; }
  export -f sleep
  run bash "$SCRIPT" rerun 123 1
  [ "$status" -eq 0 ]
  [ "$(cat "$POLL_COUNTER")" -eq 3 ]
  [ "$(grep -Fc 'run rerun' "$GH_CALLS")" -eq 1 ]
}

@test "a run that never completes within the bound is skipped" {
  export FAKE_RUN_IN_PROGRESS_POLLS=99
  run bash "$SCRIPT" rerun 123 1
  assert_no_rerun
  [[ "$output" == *'did not complete'* ]]
}

@test "a run already rerun by someone else is not rerun again" {
  jq '.attempt = 2' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  run bash "$SCRIPT" rerun 123 1
  assert_no_rerun
  [[ "$output" == *'already on attempt 2'* ]]
}

@test "rerun rejects non-numeric workflow_dispatch inputs without calling gh" {
  run bash "$SCRIPT" rerun '123; echo hi' 1
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" rerun 123 '1 2'
  [ "$status" -eq 2 ]
  [ ! -f "$GH_CALLS" ]
}

@test "check qualifies a log with the contention marker" {
  run bash "$SCRIPT" check "$JOB_LOG"
  [ "$status" -eq 0 ]
}

@test "check does not qualify a plain failure or a missing log" {
  echo 'FAIL: a real assertion failure' > "$JOB_LOG"
  run bash "$SCRIPT" check "$JOB_LOG"
  [ "$status" -eq 1 ]
  run bash "$SCRIPT" check "$BATS_TEST_TMPDIR/absent.log"
  [ "$status" -eq 1 ]
}

@test "dispatch requests the rerun workflow once for a qualifying first attempt" {
  run bash "$SCRIPT" dispatch "$JOB_LOG" 123 1
  [ "$status" -eq 0 ]
  [ "$(grep -Fc 'workflow run rerun-contended-runner.yml -R kaeawc/auto-mobile -f run_id=123 -f run_attempt=1' "$GH_CALLS")" -eq 1 ]
  [ "$(wc -l < "$GH_CALLS")" -eq 1 ]
}

@test "dispatch does nothing on attempt two" {
  run bash "$SCRIPT" dispatch "$JOB_LOG" 123 2
  [ "$status" -eq 0 ]
  [[ "$output" == *'not the first attempt'* ]]
  [ ! -f "$GH_CALLS" ]
}

@test "dispatch does nothing when the failure is not contention" {
  echo 'FAIL: a real assertion failure' > "$JOB_LOG"
  run bash "$SCRIPT" dispatch "$JOB_LOG" 123 1
  [ "$status" -eq 0 ]
  [[ "$output" == *'not runner contention'* ]]
  [ ! -f "$GH_CALLS" ]
}

@test "dispatch ignores non-numeric ids without failing" {
  run bash "$SCRIPT" dispatch "$JOB_LOG" 'abc' 1
  [ "$status" -eq 0 ]
  [[ "$output" == *'must be numeric'* ]]
  [ ! -f "$GH_CALLS" ]
}

@test "dispatch with a read-only token (fork PR) is a clean no-op" {
  export FAKE_DISPATCH_FAIL=1
  run bash "$SCRIPT" dispatch "$JOB_LOG" 123 1
  [ "$status" -eq 0 ]
  [[ "$output" == *'Could not dispatch'* ]]
  ! grep -F 'run rerun 123' "$GH_CALLS"
}

@test "unknown subcommand and bare invocation print usage" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" 123 1
  [ "$status" -eq 2 ]
}
