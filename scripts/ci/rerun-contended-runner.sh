#!/usr/bin/env bash
# Retry a contended unit lane once, only when every failed job qualifies.
#
# Subcommands (one shared qualification rule, #12758):
#   check <log-file>
#       Exit 0 when the log carries the unit-shard contention marker. Used by
#       the unit job itself on its own output, and by `rerun` on fetched logs.
#   dispatch <log-file> <run-id> <run-attempt>
#       Run from the failing unit job. When the local log qualifies and this is
#       the first attempt, dispatch rerun-contended-runner.yml. Never fails the
#       job: a read-only token (fork PRs) or an API error is a logged no-op.
#   rerun <run-id> <run-attempt>
#       Run by the dispatched workflow. Wait (bounded) for the run to finish,
#       re-verify that every failed job qualifies, then rerun --failed once.
set -euo pipefail

REPO="${REPO:-kaeawc/auto-mobile}"
LOG_FETCH_RETRY_SLEEP_SECONDS="${LOG_FETCH_RETRY_SLEEP_SECONDS:-5}"
RERUN_WAIT_SLEEP_SECONDS="${RERUN_WAIT_SLEEP_SECONDS:-30}"
RERUN_WAIT_TIMEOUT_SECONDS="${RERUN_WAIT_TIMEOUT_SECONDS:-6000}"
WORKFLOW_FILE="rerun-contended-runner.yml"
CONTENTION_MARKER='RUNNER-CONTENDED: unit shard'

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/ci/rerun-contended-runner.sh check <log-file>
  scripts/ci/rerun-contended-runner.sh dispatch <log-file> <run-id> <run-attempt>
  scripts/ci/rerun-contended-runner.sh rerun <run-id> <run-attempt>
USAGE
  exit 2
}

# The single qualification rule: the text carries $CONTENTION_MARKER. Kept as
# inline [[ ]] tests, not predicate functions, so set -e stays active (#3637).
NUMERIC_RE='^[0-9]+$'

cmd_check() {
  [[ "$#" -eq 1 ]] || usage
  local text
  if [[ ! -f "$1" ]]; then
    echo "No log at '$1': not qualifying."
    return 1
  fi
  text="$(sed -n 'p' "$1")"
  [[ "$text" == *"$CONTENTION_MARKER"* ]]
}

cmd_dispatch() {
  [[ "$#" -eq 3 ]] || usage
  local log_file="$1" run_id="$2" run_attempt="$3"
  if [[ ! "$run_id" =~ $NUMERIC_RE || ! "$run_attempt" =~ $NUMERIC_RE ]]; then
    echo "Skipping rerun dispatch: run id and attempt must be numeric."
    return 0
  fi
  if [[ "$run_attempt" != 1 ]]; then
    echo "Skipping rerun dispatch for run $run_id: attempt $run_attempt is not the first attempt."
    return 0
  fi
  local log_text=""
  [[ ! -f "$log_file" ]] || log_text="$(sed -n 'p' "$log_file")"
  if [[ "$log_text" != *"$CONTENTION_MARKER"* ]]; then
    echo "Skipping rerun dispatch for run $run_id: failure is not runner contention."
    return 0
  fi
  if gh workflow run "$WORKFLOW_FILE" -R "$REPO" -f "run_id=$run_id" -f "run_attempt=$run_attempt"; then
    echo "Dispatched $WORKFLOW_FILE for run $run_id: unit job reported runner contention."
  else
    # Fork PRs get a read-only token, and the API can fail: the failed unit job
    # is the signal that matters, so this stays a logged no-op.
    echo "::warning::Could not dispatch $WORKFLOW_FILE for run $run_id (read-only token or API error); no rerun requested."
  fi
  return 0
}

cmd_rerun() {
  [[ "$#" -eq 2 ]] || usage
  local run_id="$1" run_attempt="$2"
  if [[ ! "$run_id" =~ $NUMERIC_RE || ! "$run_attempt" =~ $NUMERIC_RE ]]; then
    echo "Run id and attempt must be numeric." >&2
    exit 2
  fi
  if [[ "$run_attempt" != 1 ]]; then
    echo "Skipping run $run_id: attempt $run_attempt is not the first attempt."
    return 0
  fi
  local max_polls polls=0 run_status=""
  max_polls=$((RERUN_WAIT_TIMEOUT_SECONDS / (RERUN_WAIT_SLEEP_SECONDS > 0 ? RERUN_WAIT_SLEEP_SECONDS : 1)))
  while true; do
    run_status="$(gh run view "$run_id" -R "$REPO" --json status --jq '.status')"
    if [[ "$run_status" == completed || "$polls" -ge "$max_polls" ]]; then
      break
    fi
    polls=$((polls + 1))
    sleep "$RERUN_WAIT_SLEEP_SECONDS"
  done
  if [[ "$run_status" != completed ]]; then
    echo "Skipping run $run_id: it did not complete within ${RERUN_WAIT_TIMEOUT_SECONDS}s."
    return 0
  fi

  local run_json current_attempt failed_jobs
  run_json="$(gh run view "$run_id" -R "$REPO" --json jobs,attempt)"
  # Rerun once: another dispatch (or a person) may already have rerun it.
  current_attempt="$(jq -r '.attempt // 1' <<< "$run_json")"
  if [[ "$current_attempt" != 1 ]]; then
    echo "Skipping run $run_id: it is already on attempt $current_attempt."
    return 0
  fi
  # Include other unsuccessful conclusions conservatively: --failed must never
  # retry an unrelated cancelled or timed-out job alongside the contended lane.
  failed_jobs="$(jq -r '.jobs[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out" or .conclusion == "startup_failure") | [.databaseId, .name] | @tsv' <<< "$run_json")"
  if [[ -z "$failed_jobs" ]]; then
    echo "Skipping run $run_id: no failed jobs."
    return 0
  fi

  # Mirror classify-failure.sh: new gh clients need this flag for ANSI logs;
  # older clients reject it. Capture help without a pipefail/grep -q race.
  local gh_api_help gh_escape_args=()
  gh_api_help="$(gh api --help 2>/dev/null || true)"
  if [[ "$gh_api_help" == *"--allow-escape-sequences"* ]]; then
    gh_escape_args=(--allow-escape-sequences)
  fi
  # Global on purpose: the EXIT trap runs after this function's scope is gone.
  log_file="$(mktemp "${TMPDIR:-/tmp}/rerun-contended-runner-log.XXXXXX")"
  trap 'rm -f "${log_file:-}"' EXIT

  local job_id job_name log_fetch_status log_fetch_attempt log_text
  while IFS=$'\t' read -r job_id job_name; do
    case "$job_name" in
      'Node Unit Tests'*|'Node TypeScript Build and Test'*|'TypeScript Code Coverage') ;;
      *)
        echo "Skipping run $run_id: failed job '$job_name' is not a unit lane."
        return 0
        ;;
    esac
    log_fetch_status=0
    for log_fetch_attempt in 1 2; do
      if gh api ${gh_escape_args[@]+"${gh_escape_args[@]}"} "repos/${REPO}/actions/jobs/${job_id}/logs" > "$log_file" </dev/null; then
        log_fetch_status=0
        break
      else
        log_fetch_status=$?
      fi
      if [[ "$log_fetch_attempt" -eq 1 ]]; then
        sleep "$LOG_FETCH_RETRY_SLEEP_SECONDS"
      fi
    done
    if [[ "$log_fetch_status" -ne 0 ]]; then
      echo "Skipping run $run_id: could not fetch logs for job '$job_name' (job $job_id) after 2 attempts; gh api exited $log_fetch_status."
      return 0
    fi
    if unzip -Z1 "$log_file" >/dev/null 2>&1; then
      log_text="$(unzip -p "$log_file")"
    else
      log_text="$(sed -n 'p' "$log_file")"
    fi
    if [[ "$log_text" != *"$CONTENTION_MARKER"* ]]; then
      echo "Skipping run $run_id: failed job '$job_name' lacks the contention marker."
      return 0
    fi
  done <<< "$failed_jobs"

  gh run rerun "$run_id" --failed -R "$REPO"
  echo "Rerunning failed jobs in run $run_id once on fresh runners: every failed job reported $CONTENTION_MARKER."
}

[[ "$#" -ge 1 ]] || usage
subcommand="$1"
shift
case "$subcommand" in
  check) cmd_check "$@" ;;
  dispatch) cmd_dispatch "$@" ;;
  rerun) cmd_rerun "$@" ;;
  *) usage ;;
esac
