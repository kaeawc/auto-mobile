#!/usr/bin/env bash
#
# Print actionable classifications for failed jobs in one pull_request.yml run.

set -euo pipefail

REPO="kaeawc/auto-mobile"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGNATURES="$SCRIPT_DIR/known-flakes.txt"
RETRY_MARKER='Starting emulator retry attempt 2.'
# shellcheck disable=SC2016 # The jq program intentionally contains jq variables.
FAILURE_CONCLUSIONS_JQ_DEF='def is_failed_conclusion: ((. // "") | ascii_downcase) as $conclusion | ($conclusion == "failure" or $conclusion == "cancelled" or $conclusion == "timed_out" or $conclusion == "startup_failure");'

usage() {
  echo "Usage: scripts/ci/classify-failure.sh <run-id>" >&2
}

if [[ "$#" -ne 1 ]]; then
  usage
  exit 2
fi

if [[ ! -f "$SIGNATURES" ]]; then
  echo "Known-flake signatures not found: $SIGNATURES" >&2
  exit 1
fi

run_id="$1"
run_json="$(gh run view "$run_id" -R "$REPO" --json jobs,headBranch)"
head_branch="$(jq -r '.headBranch // ""' <<< "$run_json")"

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

match_signature() {
  local job_name="$1"
  local annotation_text="$2"
  local job_lc annotation_lc job_pattern message_pattern verdict note
  job_lc="$(lowercase "$job_name")"
  annotation_lc="$(lowercase "$annotation_text")"

  while IFS='|' read -r job_pattern message_pattern verdict note; do
    [[ -n "$job_pattern" ]] || continue
    [[ "$job_pattern" == \#* ]] && continue
    job_pattern="$(lowercase "$job_pattern")"
    message_pattern="$(lowercase "$message_pattern")"
    # shellcheck disable=SC2053 # Signature fields deliberately use shell globs.
    if [[ "$job_lc" == $job_pattern && "$annotation_lc" == $message_pattern ]]; then
      printf '%s — %s' "$verdict" "$note"
      return 0
    fi
  done < "$SIGNATURES"

  printf '%s' 'UNKNOWN — no signature match, investigate'
}

executed_retry_marker_present() {
  local evidence="$1" line normalized in_group=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *'##[group]Run'* ]]; then
      in_group=1
    fi
    if [[ "$line" == *'##[endgroup]'* ]]; then
      in_group=0
      continue
    fi
    normalized="$line"
    if [[ "$normalized" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^[:space:]]+Z[[:space:]](.*)$ ]]; then
      normalized="${BASH_REMATCH[1]}"
    fi
    if [[ "$normalized" == "$RETRY_MARKER" && "$in_group" -eq 0 && "$line" != *'echo "'*"$RETRY_MARKER"*'"'* ]]; then
      return 0
    fi
  done <<< "$evidence"
  return 1
}

terminal_attempt_evidence() {
  local evidence="$1"
  local diagnostics_marker='First emulator attempt failed; captured diagnostics follow:'
  local line normalized in_group=0 after_marker=0 terminal=''

  # shellcheck disable=SC2310 # A predicate: a false result is expected control flow.
  if executed_retry_marker_present "$evidence"; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == *'##[group]Run'* ]]; then
        in_group=1
      fi
      if [[ "$line" == *'##[endgroup]'* ]]; then
        in_group=0
        continue
      fi
      normalized="$line"
      if [[ "$normalized" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^[:space:]]+Z[[:space:]](.*)$ ]]; then
        normalized="${BASH_REMATCH[1]}"
      fi
      if [[ "$normalized" == "$RETRY_MARKER" && "$in_group" -eq 0 && "$line" != *'echo "'*"$RETRY_MARKER"*'"'* ]]; then
        after_marker=1
        terminal=''
      elif [[ "$after_marker" -eq 1 ]]; then
        terminal+="$line"$'\n'
      fi
    done <<< "$evidence"
    printf '%s' "${terminal%$'\n'}"
  elif [[ "$evidence" == *"$diagnostics_marker"* ]]; then
    printf '%s' "$evidence"
  else
    printf '%s' "$evidence"
  fi
}

ambiguous_terminal_attempt() {
  local evidence="$1"
  local diagnostics_marker='First emulator attempt failed; captured diagnostics follow:'

  # shellcheck disable=SC2310 # A predicate: a false result is expected control flow.
  [[ "$evidence" == *"$diagnostics_marker"* ]] \
    && ! executed_retry_marker_present "$evidence"
}

# Gate outcomes are emitted only when every failed upstream job in this run is
# advisory. This tells a reader to inspect this report's real upstream rows
# rather than treating a roll-up context as the failing test.
advisory_only_gate() {
  local gate="$1"
  local failures
  failures="$(jq -r "${FAILURE_CONCLUSIONS_JQ_DEF}"$'
    .jobs[]
    | select(.conclusion | is_failed_conclusion)
    | .name
  ' <<< "$run_json")"
  case "$gate" in
    iOS)
      # No advisory lane is inside the iOS gate as of #6943; an iOS aggregator
      # failure can therefore only be caused by a hard dependency.
      return 1
      ;;
    Android)
      [[ -n "$failures" ]] \
        && grep -Eq '^Run (JUnit Runner Emulator|Playground Automobile Emulator)' <<< "$failures" \
        && ! grep -Eq '^(Detect Documentation-Only or SHA256-Only Changes|Build CtrlProxy APK|Build JUnitRunner Library|Build Playground App|SDK Debug Inspector Consumer|JUnit Runner Kotlin Consumer Compatibility|Run JUnit Runner Unit Tests|Run CtrlProxy Unit Tests|Android Emulator Compile Smoke)$' <<< "$failures"
      ;;
    'Node Tests')
      [[ -n "$failures" ]] \
        && grep -Eq '^Node Unit Timing Budget$' <<< "$failures" \
        && ! grep -Eq '^(Node Unit Tests|Node Host Integration Tests)' <<< "$failures"
      ;;
    WebRTC)
      [[ -n "$failures" ]] \
        && grep -Eq '^(Android Device Capture to WHEP|iOS Device Capture to WHEP)' <<< "$failures" \
        && ! grep -Eq '^WebRTC Publisher Integration' <<< "$failures"
      ;;
    *) return 1 ;;
  esac
}

read_log_file() {
  local log_file="$1"
  if [[ ! -s "$log_file" ]]; then
    return 0
  fi
  if unzip -Z1 "$log_file" >/dev/null 2>&1; then
    unzip -p "$log_file" 2>/dev/null || true
  else
    sed -n 'p' "$log_file"
  fi
}

# gh >= 2.101.0 refuses to emit a log body containing terminal escape sequences
# unless --allow-escape-sequences is passed (it exits non-zero and writes
# nothing, even to a file). Job logs are full of ANSI colour codes, so without
# the flag on a new client the log comes back empty and every log-based
# signature silently stops matching. But older gh (< 2.101.0) has no such flag
# and rejects it as "unknown flag" — while needing no flag to emit the log.
#
# Detect support once and record the extra `gh api` args in an array. Keeping the
# `gh api` call at the call site (an external command, not a function invoked in
# the `if`) preserves `set -e` there; this helper is a bare statement that always
# returns 0.
_gh_escape_args_ready=""
_gh_escape_args=()
prepare_gh_escape_args() {
  [[ -n "$_gh_escape_args_ready" ]] && return 0
  # Capture help text, then string-match — do NOT pipe into `grep -q`, whose
  # early close SIGPIPEs `gh` and, under `set -o pipefail`, would misreport the
  # flag as unsupported.
  local gh_api_help
  gh_api_help="$(gh api --help 2>/dev/null || true)"
  if [[ "$gh_api_help" == *"--allow-escape-sequences"* ]]; then
    _gh_escape_args=(--allow-escape-sequences)
  else
    _gh_escape_args=()
  fi
  _gh_escape_args_ready="yes"
  return 0
}

fetch_job_log() {
  local job_id="$1"
  local log_file log_text=''
  log_file="$(mktemp "${TMPDIR:-/tmp}/classify-failure-job-log.XXXXXX")"
  prepare_gh_escape_args
  if gh api ${_gh_escape_args[@]+"${_gh_escape_args[@]}"} "repos/${REPO}/actions/jobs/${job_id}/logs" > "$log_file" 2>/dev/null; then
    log_text="$(read_log_file "$log_file")"
  fi
  rm -f "$log_file"
  printf '%s' "$log_text"
}

fetch_artifact_logs() {
  local job_name="$1"
  local matrix_suffix artifact_name artifacts artifact_id artifact_file artifact_text=''
  if [[ "$job_name" != "Node TypeScript Build and Test ("* ]]; then
    return 0
  fi
  if [[ ! "$job_name" =~ \(([^\(\)]*)\)$ ]]; then
    return 0
  fi
  matrix_suffix="$(lowercase "${BASH_REMATCH[1]}")"
  matrix_suffix="${matrix_suffix// /-}"
  artifact_name="mcp-build-test-logs-${matrix_suffix}"
  if ! artifacts="$(gh api --paginate --slurp "repos/${REPO}/actions/runs/${run_id}/artifacts?per_page=100" 2>/dev/null)"; then
    return 0
  fi
  while IFS= read -r artifact_id; do
    [[ -n "$artifact_id" ]] || continue
    artifact_file="$(mktemp "${TMPDIR:-/tmp}/classify-failure-artifact-log.XXXXXX")"
    if gh api "repos/${REPO}/actions/artifacts/${artifact_id}/zip" > "$artifact_file" 2>/dev/null; then
      artifact_text+="$(read_log_file "$artifact_file")"
    fi
    rm -f "$artifact_file"
  done < <(
    jq -r --arg artifact_name "$artifact_name" '[.[].artifacts[]? | select(.name == $artifact_name) | .id] | .[]' <<< "$artifacts"
  )
  printf '%s' "$artifact_text"
}

failed_count=0
while IFS=$'\t' read -r job_id job_name steps; do
  [[ -n "$job_id" ]] || continue
  failed_count=$((failed_count + 1))
  annotations=''
  if ! annotations="$(gh api --paginate --slurp "repos/${REPO}/check-runs/${job_id}/annotations?per_page=100" 2>/dev/null)"; then
    annotations='[[]]'
  fi
  annotation_text="$(jq -r '[.[][]? | (.message // .raw_details // "")] | map(select(length > 0)) | join("; ")' <<< "$annotations")"
  if [[ -z "$annotation_text" ]]; then
    annotation_text='none'
  fi
  log_text="$(fetch_job_log "$job_id")"
  if [[ -z "$log_text" ]]; then
    log_text="$(fetch_artifact_logs "$job_name")"
  fi

  # shellcheck disable=SC2310 # A non-match is expected classifier control flow.
  if advisory_only_gate "$job_name"; then
    verdict='CHECK-UPSTREAM-FIRST — aggregator is red because of an advisory (non-required) lane; inspect the upstream rows above before rerunning or filing an issue'
  elif [[ "${head_branch} ${annotation_text} ${log_text}" == *"$RETRY_MARKER"* ]] \
    && ! executed_retry_marker_present "${head_branch} ${annotation_text} ${log_text}"; then
    verdict='UNKNOWN — retry attempt never executed; echoed retry marker is not terminal-attempt evidence'
  elif ambiguous_terminal_attempt "${head_branch} ${annotation_text} ${log_text}"; then
    verdict='UNKNOWN — log predates the retry marker; attempt-one diagnostics are not authoritative for the terminal attempt'
  else
    evidence="$(terminal_attempt_evidence "${head_branch} ${annotation_text} ${log_text}")"
    verdict="$(match_signature "$job_name" "$evidence")"
  fi

  printf '%s → %s → %s → %s\n' "$job_name" "${steps:-none}" "$annotation_text" "$verdict"
done < <(
  jq -r "${FAILURE_CONCLUSIONS_JQ_DEF}"$'
    .jobs[]
    | select(.conclusion | is_failed_conclusion)
    | [(.databaseId // .id // ""), .name, ([.steps[]? | select(.conclusion | is_failed_conclusion) | .name] | join(", "))]
    | @tsv
  ' <<< "$run_json"
)

if [[ "$failed_count" -eq 0 ]]; then
  echo "No failed or cancelled jobs in run ${run_id}."
fi
