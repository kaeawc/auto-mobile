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
#
# The workflow is parsed STRUCTURALLY, not with line regexes. An earlier revision
# of this guard matched `^  <name>:` by indentation and was therefore blind to a
# validly-quoted key: adding `"sneaky-job":` with no timeout kept the suite green
# while the job really did inherit 360. A guard that can be bypassed by quoting a
# key is worse than no guard, because it reads as coverage.

WORKFLOW=".github/workflows/pull_request.yml"

# Print the name of every job that does not declare a job-level timeout-minutes.
#
# Jobs that call a reusable workflow (`uses:`) are exempt -- GitHub rejects
# timeout-minutes on the caller side for those. There are none today; the branch
# exists so adding one later does not produce an unsatisfiable failure.
jobs_missing_timeout() {
  python3 - "$1" <<'PY'
import sys

import yaml

with open(sys.argv[1]) as handle:
    document = yaml.safe_load(handle)

jobs = (document or {}).get("jobs") or {}
for name, spec in jobs.items():
    if not isinstance(spec, dict):
        continue
    if "uses" in spec:
        continue
    if "timeout-minutes" not in spec:
        print(name)
PY
}

# Total job count, so a parser that silently returns nothing cannot pass by
# finding zero offenders in zero jobs.
job_count() {
  python3 - "$1" <<'PY'
import sys

import yaml

with open(sys.argv[1]) as handle:
    document = yaml.safe_load(handle)

print(len(((document or {}).get("jobs") or {})))
PY
}

@test "the workflow parses and defines a plausible number of jobs" {
  run job_count "$WORKFLOW"
  [ "$status" -eq 0 ]
  [ "$output" -ge 20 ]
}

@test "every pull_request job declares timeout-minutes" {
  run jobs_missing_timeout "$WORKFLOW"
  [ "$status" -eq 0 ]
  if [ -n "$output" ]; then
    echo "Jobs missing timeout-minutes (they inherit GitHub's 360-minute default):" >&2
    echo "$output" >&2
  fi
  [ -z "$output" ]
}

@test "the guard sees a validly-quoted job key" {
  # Regression for the reviewer's case on #4156: the previous indentation-regex
  # extractor skipped quoted keys entirely, so `"sneaky-job":` could inherit 360
  # while this suite stayed green.
  local fixture="${BATS_TEST_TMPDIR:-/tmp}/quoted-key-$$.yml"
  cat > "$fixture" <<'YAML'
name: fixture
on: [push]
jobs:
  plain-job:
    timeout-minutes: 5
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
  "sneaky-job":
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
YAML

  run job_count "$fixture"
  [ "$output" -eq 2 ]

  run jobs_missing_timeout "$fixture"
  [ "$output" = "sneaky-job" ]

  rm -f "$fixture"
}

@test "a job calling a reusable workflow is exempt" {
  # GitHub rejects timeout-minutes on a `uses:` job, so demanding one would be
  # unsatisfiable rather than protective.
  local fixture="${BATS_TEST_TMPDIR:-/tmp}/reusable-$$.yml"
  cat > "$fixture" <<'YAML'
name: fixture
on: [push]
jobs:
  calls-reusable:
    uses: ./.github/workflows/other.yml
YAML

  run jobs_missing_timeout "$fixture"
  [ -z "$output" ]

  rm -f "$fixture"
}
