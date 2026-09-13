#!/usr/bin/env bash
#
# Print actionable classifications for failed jobs in one pull_request.yml run.

set -euo pipefail

REPO="kaeawc/auto-mobile"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGNATURES="$SCRIPT_DIR/known-flakes.txt"

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

# Gate outcomes are emitted only when every failed upstream job in this run is
# advisory. This tells a reader to inspect this report's real upstream rows
# rather than treating a roll-up context as the failing test.
advisory_only_gate() {
  local gate="$1"
  local failures
  failures="$(jq -r '
    .jobs[]
    | select((((.conclusion // "") | ascii_downcase) == "failure") or (((.conclusion // "") | ascii_downcase) == "cancelled"))
    | .name
  ' <<< "$run_json")"
  case "$gate" in
    iOS)
      [[ -n "$failures" ]] \
        && grep -Fqx 'XCTestRunner Simulator Tests' <<< "$failures" \
        && ! grep -Eq '^(iOS Build|iOS Playground Tests( \(.*\))?|Build Root SPM Package)$' <<< "$failures"
      ;;
    Android)
      [[ -n "$failures" ]] \
        && grep -Eq '^Run (JUnit Runner Emulator|Playground Automobile Emulator)' <<< "$failures" \
        && ! grep -Eq '^(Detect Documentation-Only or SHA256-Only Changes|Build CtrlProxy APK|Build JUnitRunner Library|Build Playground App|SDK Debug Inspector Consumer|JUnit Runner Kotlin Consumer Compatibility|Run JUnit Runner Unit Tests|Run CtrlProxy Unit Tests)$' <<< "$failures"
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

fetch_job_log() {
  local job_id="$1"
  local log_file log_text=''
  log_file="$(mktemp "${TMPDIR:-/tmp}/classify-failure-job-log.XXXXXX")"
  if gh api "repos/${REPO}/actions/jobs/${job_id}/logs" > "$log_file" 2>/dev/null; then
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
  if ! annotations="$(gh api "repos/${REPO}/check-runs/${job_id}/annotations" 2>/dev/null)"; then
    annotations='[]'
  fi
  annotation_text="$(jq -r '[.[]? | (.message // .raw_details // "")] | map(select(length > 0)) | join("; ")' <<< "$annotations")"
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
  else
    verdict="$(match_signature "$job_name" "${head_branch} ${annotation_text} ${log_text}")"
  fi

  printf '%s → %s → %s → %s\n' "$job_name" "${steps:-none}" "$annotation_text" "$verdict"
done < <(
  jq -r '
    .jobs[]
    | select((((.conclusion // "") | ascii_downcase) == "failure") or (((.conclusion // "") | ascii_downcase) == "cancelled"))
    | [(.databaseId // .id // ""), .name, ([.steps[]? | select(((.conclusion // "") | ascii_downcase) == "failure" or ((.conclusion // "") | ascii_downcase) == "cancelled") | .name] | join(", "))]
    | @tsv
  ' <<< "$run_json"
)

if [[ "$failed_count" -eq 0 ]]; then
  echo "No failed or cancelled jobs in run ${run_id}."
fi
