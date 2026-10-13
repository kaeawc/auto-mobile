#!/usr/bin/env bats

setup() {
  export FIX="$BATS_TEST_TMPDIR"
  export PATH="$FIX:$PATH"
  export GITHUB_REPOSITORY=kaeawc/auto-mobile GITHUB_RUN_ID=123 GH_TOKEN=fake
  export GITHUB_RUN_ATTEMPT=2 MAC_QUEUE_STUCK_SECONDS=60 MAC_QUEUE_POLL_SECONDS=30
  export MAC_QUEUE_NOW_CMD="$FIX/clock" GITHUB_STEP_SUMMARY="$FIX/summary"
  printf 0 > "$FIX/polls"
  printf 120 > "$FIX/time"
  cat > "$FIX/clock" <<'FAKE'
#!/usr/bin/env bash
cat "$FIX/time"
FAKE
  cat > "$FIX/sleep" <<'FAKE'
#!/usr/bin/env bash
printf '%s' "$(( $(cat "$FIX/time") + $1 ))" > "$FIX/time"
FAKE
  cat > "$FIX/gh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIX/calls"
n=$(( $(cat "$FIX/polls") + 1 ))
printf '%s' "$n" > "$FIX/polls"
if [[ -f "$FIX/fail" ]]; then exit 1; fi
cat "$FIX/$n.json"
FAKE
  chmod +x "$FIX/clock" "$FIX/sleep" "$FIX/gh"
  printf '{"jobs":[]}' > "$FIX/1.json"
  printf '{"jobs":[]}' > "$FIX/2.json"
  printf '{"jobs":[]}' > "$FIX/3.json"
}

# JSON fixtures are constructed with jq, not parsed with line matching.
queue_job() {
  jq -n --arg label "${2:-self-hosted}" --arg created "${3:-1970-01-01T00:02:00Z}" \
    '{jobs:[{id:1,name:"Swift Packages",labels:[$label,"automobile-mac"],status:"queued",created_at:$created}]}' > "$FIX/$1.json"
}

@test "all started on second poll counts distinct self-hosted jobs" {
  queue_job 1
  jq '.jobs[0].status="in_progress"' "$FIX/1.json" > "$FIX/2.json"
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"saw 1 self-hosted jobs start"* ]]
  [ "$(cat "$FIX/polls")" -eq 2 ]
  grep -Fx 'api --paginate /repos/kaeawc/auto-mobile/actions/runs/123/attempts/2/jobs?per_page=100' "$FIX/calls"
}

@test "first empty poll is not trusted" {
  queue_job 2 self-hosted 1970-01-01T00:00:00Z
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 1 ]
  [ "$(cat "$FIX/polls")" -eq 2 ]
}

@test "stuck job names pool remedy and writes summary" {
  queue_job 1 self-hosted 1970-01-01T00:00:00Z
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error title=Self-hosted Mac queue::Swift Packages"* ]]
  [[ "$output" == *"automobile-mac"*"2 minutes waited"* ]]
  [[ "$output" == *"AUTOMOBILE_MAC_POOLS_ENABLED to any value other than true"* ]]
  [[ "$output" == *"re-run the workflow"*"macos-capacity-plan.md"* ]]
  [ "$(cat "$FIX/summary")" = "${output#*::error title=Self-hosted Mac queue::}" ]
}

@test "queued under threshold then starts exits successfully" {
  queue_job 1
  queue_job 2
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 0 ]
  [ "$(cat "$FIX/polls")" -eq 3 ]
}

@test "non-self-hosted queued jobs are ignored" {
  queue_job 1 ubuntu-latest 1970-01-01T00:00:00Z
  cp "$FIX/1.json" "$FIX/2.json"
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"saw 0 self-hosted jobs start"* ]]
}

@test "API failure stays advisory at threshold" {
  touch "$FIX/fail"
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"::warning::"*"queue could not be checked"* ]]
  [ "$(cat "$FIX/time")" -eq 180 ]
}

@test "garbled API response stays advisory at threshold" {
  printf 'not JSON' | tee "$FIX/1.json" "$FIX/2.json" > "$FIX/3.json"
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"queue could not be checked"* ]]
}

@test "paginated gh output includes stuck jobs on later pages" {
  queue_job 1 self-hosted 1970-01-01T00:00:00Z
  printf '{"jobs":[]}\n' > "$FIX/pages"
  cat "$FIX/1.json" >> "$FIX/pages"
  cp "$FIX/pages" "$FIX/1.json"
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Swift Packages"* ]]
}

@test "queue younger than observation window stops at total runtime bound" {
  for n in 1 2 3 4; do queue_job "$n" self-hosted 1970-01-01T00:04:00Z; done
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"runtime bound"* ]]
  [ "$(cat "$FIX/time")" -eq 240 ]
}

@test "attempt defaults to one" {
  unset GITHUB_RUN_ATTEMPT
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 0 ]
  grep -F 'attempts/1/jobs?per_page=100' "$FIX/calls"
}

@test "a stalled API is bounded and remains advisory" {
  cat > "$FIX/timeout" <<'FAKE'
#!/usr/bin/env bash
[[ "$1 $2" == '--foreground --signal=KILL' ]] || exit 2
printf '%s' "$(( $(cat "$FIX/time") + ${3%s} ))" > "$FIX/time"
exit 137
FAKE
  chmod +x "$FIX/timeout"
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"queue could not be checked"* ]]
  [ "$(cat "$FIX/time")" -eq 240 ]
  [ ! -e "$FIX/calls" ]
}

@test "job created shortly after the watchdog started and never picked up -> exit 1" {
  for n in 1 2 3 4; do queue_job "$n" self-hosted 1970-01-01T00:02:02Z; done
  run bash scripts/ci/mac-queue-watchdog.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error title=Self-hosted Mac queue::Swift Packages"* ]]
  [ "$(cat "$FIX/polls")" -eq 4 ]
  [ "$(cat "$FIX/time")" -eq 210 ]
}
