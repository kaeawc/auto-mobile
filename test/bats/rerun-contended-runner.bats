#!/usr/bin/env bats

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ci/rerun-contended-runner.sh"

setup() {
  export FIXTURE="$BATS_TEST_TMPDIR/run.json"
  export GH_CALLS="$BATS_TEST_TMPDIR/gh-calls"
  export JOB_LOG="$BATS_TEST_TMPDIR/job.log"
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
  'run view') cat "$FIXTURE" ;;
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
    [[ "${FAKE_LOG_ERROR:-0}" == 0 ]] || exit 1
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
  run bash "$SCRIPT" 123 1
  [ "$status" -eq 0 ]
  [[ "$output" == *'Rerunning failed jobs'* ]]
  grep -Fx 'run view 123 -R kaeawc/auto-mobile --json jobs' "$GH_CALLS"
  grep -Fx 'api --allow-escape-sequences repos/kaeawc/auto-mobile/actions/jobs/1/logs' "$GH_CALLS"
  [ "$(grep -Fc 'run rerun 123 --failed -R kaeawc/auto-mobile' "$GH_CALLS")" -eq 1 ]
}

@test "attempt two does nothing without querying GitHub" {
  run bash "$SCRIPT" 123 2
  assert_no_rerun
  [[ "$output" == *'not the first attempt'* ]]
  [ ! -f "$GH_CALLS" ]
}

@test "another failed job prevents the whole rerun" {
  jq '.jobs += [{databaseId:2,name:"Bun Lint",conclusion:"failure"}]' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  run bash "$SCRIPT" 123 1
  assert_no_rerun
  [[ "$output" == *"'Bun Lint' is not a unit lane"* ]]
}

@test "failed unit job without marker is not retried" {
  echo 'FAIL: a real assertion failure' > "$JOB_LOG"
  run bash "$SCRIPT" 123 1
  assert_no_rerun
  [[ "$output" == *'lacks the contention marker'* ]]
}

@test "Windows build and test job variant is retried" {
  jq '.jobs[0].name = "Node TypeScript Build and Test (windows-latest)"' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  run bash "$SCRIPT" 123 1
  [ "$status" -eq 0 ]
  grep -Fx 'run rerun 123 --failed -R kaeawc/auto-mobile' "$GH_CALLS"
}

@test "every failed unit job must have the marker" {
  jq '.jobs += [{databaseId:2,name:"Node Unit Tests (macos-latest)",conclusion:"failure"}]' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  # Return the real failure for job 2 while keeping contention evidence for job 1.
  sed -i.bak 's/cat "$JOB_LOG"/if [[ "$*" == *jobs\/2\/logs ]]; then echo "FAIL assertion"; else cat "$JOB_LOG"; fi/' "$BATS_TEST_TMPDIR/bin/gh"
  run bash "$SCRIPT" 123 1
  assert_no_rerun
  [[ "$output" == *'macos-latest'* ]]
}

@test "multiple contended unit failures cause one failed-jobs rerun" {
  jq '.jobs += [{databaseId:2,name:"Node Unit Tests (macos-latest)",conclusion:"failure"},{databaseId:3,name:"Bun Lint",conclusion:"success"}]' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  run bash "$SCRIPT" 123 1
  [ "$status" -eq 0 ]
  [ "$(grep -Fc 'run rerun' "$GH_CALLS")" -eq 1 ]
  grep -F 'actions/jobs/2/logs' "$GH_CALLS"
  ! grep -F 'actions/jobs/3/logs' "$GH_CALLS"
}

@test "no failed jobs does nothing" {
  echo '{"jobs":[]}' > "$FIXTURE"
  run bash "$SCRIPT" 123 1
  assert_no_rerun
  [[ "$output" == *'no failed jobs'* ]]
}

@test "older gh clients and repository override are supported" {
  export FAKE_GH_ALLOW_ESCAPE=unsupported
  export REPO=example/project
  run bash "$SCRIPT" 123 1
  [ "$status" -eq 0 ]
  grep -Fx 'api repos/example/project/actions/jobs/1/logs' "$GH_CALLS"
  grep -Fx 'run rerun 123 --failed -R example/project' "$GH_CALLS"
}

@test "zipped job logs are read" {
  mv "$JOB_LOG" "$BATS_TEST_TMPDIR/plain.log"
  zip -jq "$JOB_LOG" "$BATS_TEST_TMPDIR/plain.log"
  run bash "$SCRIPT" 123 1
  [ "$status" -eq 0 ]
  grep -F 'run rerun' "$GH_CALLS"
}

@test "log API errors fail without rerunning" {
  export FAKE_LOG_ERROR=1
  run bash "$SCRIPT" 123 1
  [ "$status" -ne 0 ]
  ! grep -F 'run rerun' "$GH_CALLS"
}

@test "unrelated timed-out jobs prevent rerunning" {
  jq '.jobs += [{databaseId:2,name:"Bun Lint",conclusion:"timed_out"}]' "$FIXTURE" > "$FIXTURE.tmp"
  mv "$FIXTURE.tmp" "$FIXTURE"
  run bash "$SCRIPT" 123 1
  assert_no_rerun
}
