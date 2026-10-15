#!/usr/bin/env bash
# Retry a contended unit lane once, only when every failed job qualifies.
set -euo pipefail

REPO="${REPO:-kaeawc/auto-mobile}"
if [[ "$#" -ne 2 ]]; then
  echo "Usage: scripts/ci/rerun-contended-runner.sh <run-id> <run-attempt>" >&2
  exit 2
fi
run_id="$1"
if [[ "$2" != 1 ]]; then
  echo "Skipping run $run_id: attempt $2 is not the first attempt."
  exit 0
fi

run_json="$(gh run view "$run_id" -R "$REPO" --json jobs)"
# Include other unsuccessful conclusions conservatively: --failed must never
# retry an unrelated cancelled or timed-out job alongside the contended lane.
failed_jobs="$(jq -r '.jobs[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out" or .conclusion == "startup_failure") | [.databaseId, .name] | @tsv' <<< "$run_json")"
if [[ -z "$failed_jobs" ]]; then
  echo "Skipping run $run_id: no failed jobs."
  exit 0
fi

# Mirror classify-failure.sh: new gh clients need this flag for ANSI logs;
# older clients reject it. Capture help without a pipefail/grep -q race.
gh_api_help="$(gh api --help 2>/dev/null || true)"
gh_escape_args=()
if [[ "$gh_api_help" == *"--allow-escape-sequences"* ]]; then
  gh_escape_args=(--allow-escape-sequences)
fi
log_file="$(mktemp "${TMPDIR:-/tmp}/rerun-contended-runner-log.XXXXXX")"
trap 'rm -f "$log_file"' EXIT

while IFS=$'\t' read -r job_id job_name; do
  case "$job_name" in
    'Node Unit Tests'*|'Node TypeScript Build and Test'*) ;;
    *)
      echo "Skipping run $run_id: failed job '$job_name' is not a unit lane."
      exit 0
      ;;
  esac
  gh api ${gh_escape_args[@]+"${gh_escape_args[@]}"} "repos/${REPO}/actions/jobs/${job_id}/logs" > "$log_file"
  if unzip -Z1 "$log_file" >/dev/null 2>&1; then
    log_text="$(unzip -p "$log_file")"
  else
    log_text="$(sed -n 'p' "$log_file")"
  fi
  if [[ "$log_text" != *'RUNNER-CONTENDED: unit shard'* ]]; then
    echo "Skipping run $run_id: failed job '$job_name' lacks the contention marker."
    exit 0
  fi
done <<< "$failed_jobs"

gh run rerun "$run_id" --failed -R "$REPO"
echo "Rerunning failed jobs in run $run_id once on fresh runners: every failed job reported RUNNER-CONTENDED: unit shard."
