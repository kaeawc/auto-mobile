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
        && ! grep -Eq '^(iOS Build|iOS Playground Tests|Build Root SPM Package)$' <<< "$failures"
      ;;
    Android)
      [[ -n "$failures" ]] \
        && grep -Eq '^(JUnit Runner Emulator|Playground AutoMobile Emulator)' <<< "$failures" \
        && ! grep -Eq '^(Build Android Control Proxy|Build JUnit Runner Library|Build Playground App|SDK Debug Inspector Consumer|JUnit Runner Kotlin Consumer Compatibility|JUnit Runner Unit Tests|Kotlin Code Coverage)$' <<< "$failures"
      ;;
    'Node Tests')
      [[ -n "$failures" ]] \
        && grep -Eq '^Node Unit Tests' <<< "$failures" \
        && ! grep -Eq '^Node Host Integration Tests' <<< "$failures"
      ;;
    WebRTC)
      [[ -n "$failures" ]] \
        && grep -Eq '^(WebRTC Publisher Integration|Android Device WebRTC|iOS Device WebRTC)' <<< "$failures"
      ;;
    *) return 1 ;;
  esac
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

  # shellcheck disable=SC2310 # A non-match is expected classifier control flow.
  if advisory_only_gate "$job_name"; then
    verdict='CHECK-UPSTREAM-FIRST — aggregator is red because of an advisory (non-required) lane; inspect the upstream rows above before rerunning or filing an issue'
  else
    verdict="$(match_signature "$job_name" "${head_branch} ${annotation_text}")"
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
