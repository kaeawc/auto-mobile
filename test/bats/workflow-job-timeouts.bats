#!/usr/bin/env bats
#
# Guards issue #4155: every job must declare `timeout-minutes`.
#
# A job without one inherits GitHub's default of 360 minutes, so any hang costs
# six hours of runner time before the platform intervenes. That is not
# hypothetical -- `bats-tests` hung on PR #4146 and was cancelled at 6h0m17s,
# matching the 360-minute default exactly. The underlying bug was a single
# unbounded `wait`; the reason it cost six hours rather than ten minutes was the
# missing ceiling.
#
# The ceilings themselves are sized from measured per-job durations
# (scripts/ci/measure-ci.sh) with generous headroom: the goal is catching hangs,
# not policing slow-but-healthy runs. A too-tight ceiling turns a slow run into a
# flake, which is a worse failure than the one being prevented.

WORKFLOWS=".github/workflows/pull_request.yml"

# Print every job key defined under the top-level `jobs:` mapping.
# awk, not sed -- BSD sed lacks the range forms this needs. Capture only starts
# after `jobs:` so a same-named key under `on:` (e.g. `pull_request:`) cannot
# masquerade as a job.
job_keys() {
  awk '
    /^jobs:/ { in_jobs = 1; next }
    !in_jobs { next }
    /^[a-z]/ { in_jobs = 0; next }
    /^  [a-z][a-z0-9_-]*:$/ { key = $0; sub(/^  /, "", key); sub(/:$/, "", key); print key }
  ' "$1"
}

# Whether a named job block declares a job-level timeout-minutes.
job_has_timeout() {
  awk -v want="  $2:" '
    $0 == want { inblock = 1; next }
    inblock && /^  [a-z][a-z0-9_-]*:$/ { exit }
    inblock && /^    timeout-minutes:/ { found = 1; exit }
    END { exit(found ? 0 : 1) }
  ' "$1"
}

@test "the job extractor finds jobs at all" {
  run job_keys "$WORKFLOWS"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | grep -c .)" -ge 20 ]
  # and it must not pick up the `on:` trigger key of the same name
  [[ "$output" != *"pull_request"* ]]
}

@test "every pull_request job declares timeout-minutes" {
  local offenders=""
  while IFS= read -r job; do
    [ -n "$job" ] || continue
    if ! job_has_timeout "$WORKFLOWS" "$job"; then
      offenders="${offenders}${job}"$'\n'
    fi
  done < <(job_keys "$WORKFLOWS")

  if [ -n "$offenders" ]; then
    echo "Jobs missing timeout-minutes (they inherit GitHub's 360-minute default):" >&2
    echo "$offenders" >&2
  fi
  [ -z "$offenders" ]
}
