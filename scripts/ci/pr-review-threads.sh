#!/usr/bin/env bash
#
# Emit a complete JSON array of review threads for a pull request.
#
# Usage: scripts/ci/pr-review-threads.sh [PR_NUMBER] [--unresolved-only]
#
# GraphQL --paginate emits one JSON document per page. --slurp retains every
# document so jq can flatten them before anything is written to stdout.
set -uo pipefail

REPO=kaeawc/auto-mobile
PR_NUMBER=""
UNRESOLVED_ONLY=false

for argument in "$@"; do
  case "$argument" in
    --unresolved-only)
      if [ "$UNRESOLVED_ONLY" = true ]; then
        echo "--unresolved-only was provided more than once." >&2
        exit 2
      fi
      UNRESOLVED_ONLY=true
      ;;
    --*)
      echo "Unknown option: ${argument}" >&2
      exit 2
      ;;
    *)
      if [ -n "$PR_NUMBER" ]; then
        echo "Only one pull request number may be provided." >&2
        exit 2
      fi
      PR_NUMBER="$argument"
      ;;
  esac
done

if [ -z "$PR_NUMBER" ]; then
  PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null) || {
    echo "No PR found for the current branch. Usage: $0 [PR_NUMBER] [--unresolved-only]" >&2
    exit 1
  }
fi

if [ -z "$PR_NUMBER" ]; then
  echo "No PR found for the current branch. Usage: $0 [PR_NUMBER] [--unresolved-only]" >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pr-review-threads.XXXXXX") || exit 1
trap 'rm -rf "$TEMP_DIR"' EXIT
PAGES_FILE="${TEMP_DIR}/pages.json"
THREADS_FILE="${TEMP_DIR}/threads.json"

# shellcheck disable=SC2016 # GraphQL variables must reach gh literally.
if ! gh api graphql --paginate --slurp -f query='
query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:100, after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ id isResolved isOutdated path line originalLine diffSide
          comments(first:20){ nodes{ author{login} body url createdAt } } } } } } }' \
  -F owner="${REPO%%/*}" -F repo="${REPO##*/}" -F pr="$PR_NUMBER" >"$PAGES_FILE"; then
  echo "Could not collect review threads for PR #${PR_NUMBER}." >&2
  exit 1
fi

# Validate the complete response before emitting anything. A malformed or partial
# GraphQL payload must fail closed rather than look like an empty feedback ledger.
if ! jq -e '
  if type != "array" or length == 0 then
    error("expected GraphQL pages array")
  elif .[-1].data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage != false then
    error("final GraphQL page indicates more review threads")
  elif all(.[]; (.data.repository.pullRequest.reviewThreads.nodes | type) == "array"
                   and (.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage | type) == "boolean")
    and all(.[] | .data.repository.pullRequest.reviewThreads.nodes[]; (.comments.nodes | type) == "array") then
    [.[] | .data.repository.pullRequest.reviewThreads.nodes[] | .comments = .comments.nodes]
  else
    error("reviewThreads nodes missing from GraphQL response")
  end
' "$PAGES_FILE" >"$THREADS_FILE"; then
  echo "Could not validate review threads for PR #${PR_NUMBER}; no partial result was emitted." >&2
  exit 1
fi

if [ "$UNRESOLVED_ONLY" = true ]; then
  jq '[.[] | select(.isResolved | not)]' "$THREADS_FILE"
else
  cat "$THREADS_FILE"
fi
