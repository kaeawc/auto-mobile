#!/usr/bin/env bash
#
# Delete stale release-prepare/<run-id> staging refs left behind by cancelled
# or aborted Prepare Release workflow runs.

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set to owner/repo}"
: "${GH_TOKEN:?GH_TOKEN must be set for gh authentication}"

max_age_days="${1:-${PRUNE_RELEASE_PREPARE_MAX_AGE_DAYS:-3}}"
if ! [[ "$max_age_days" =~ ^[0-9]+$ ]]; then
  echo "ERROR: age threshold must be a non-negative whole number of days" >&2
  exit 2
fi

readonly REF_PREFIX="release-prepare/"
readonly API_PREFIX="repos/${GITHUB_REPOSITORY}"

list_refs() {
  gh api "${API_PREFIX}/git/matching-refs/heads/${REF_PREFIX}"
}

get_commit_date() {
  local sha="$1"
  gh api "${API_PREFIX}/git/commits/${sha}" --jq '.commit.committer.date'
}

delete_ref() {
  local branch="$1"
  gh api -X DELETE "${API_PREFIX}/git/refs/heads/${branch}"
}

current_epoch() {
  if [[ -n "${PRUNE_RELEASE_PREPARE_NOW_EPOCH:-}" ]]; then
    printf '%s\n' "$PRUNE_RELEASE_PREPARE_NOW_EPOCH"
  else
    date -u +%s
  fi
}

iso_to_epoch() {
  local timestamp="$1"
  python3 -c '
import datetime
import sys

timestamp = sys.argv[1]
print(int(datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()))
' "$timestamp"
}

threshold_seconds=$((max_age_days * 24 * 60 * 60))
now_epoch="$(current_epoch)"
if ! [[ "$now_epoch" =~ ^[0-9]+$ ]]; then
  echo "ERROR: current epoch must be a non-negative integer" >&2
  exit 2
fi

refs_json="$(list_refs)"
refs=()
while IFS= read -r ref_and_sha; do
  refs+=("$ref_and_sha")
done < <(
  jq -r --arg prefix "refs/heads/${REF_PREFIX}" '
    .[]
    | select(.ref | startswith($prefix))
    | [.ref, .object.sha]
    | @tsv
  ' <<<"$refs_json"
)

if ((${#refs[@]} == 0)); then
  echo "No ${REF_PREFIX} staging refs found."
  exit 0
fi

for ref_and_sha in "${refs[@]}"; do
  IFS=$'\t' read -r ref sha <<<"$ref_and_sha"
  branch="${ref#refs/heads/}"

  # Keep the destructive API endpoint protected even if GitHub changes the
  # matching-refs response or this parser is later edited.
  if [[ "$branch" != "${REF_PREFIX}"* ]]; then
    echo "Skipping unexpected ref outside ${REF_PREFIX}: ${ref}" >&2
    continue
  fi

  commit_date="$(get_commit_date "$sha")"
  commit_epoch="$(iso_to_epoch "$commit_date")"
  age_seconds=$((now_epoch - commit_epoch))

  if ((age_seconds > threshold_seconds)); then
    echo "Deleting stale staging ref ${branch} (commit ${commit_date})."
    delete_ref "$branch"
  else
    echo "Skipping staging ref ${branch}: commit ${commit_date} is not older than ${max_age_days} day(s)."
  fi
done
