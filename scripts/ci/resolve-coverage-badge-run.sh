#!/usr/bin/env bash
# Find the latest successful On Merge run on main that still carries a coverage
# badge artifact, so the docs deploy never fails just because a recent window of
# runs has none (issue #11467). The Swift badge is only uploaded when ios/**
# changed, so many consecutive runs legitimately carry no badge.
#
#   resolve-coverage-badge-run.sh resolve <artifact-name>
#       Pages the repo's artifacts of that name (newest first), keeps the
#       non-expired ones from main, and picks the first whose run is a
#       successful merge.yml run. Writes run-id=<id> to $GITHUB_OUTPUT (stdout
#       when unset). When nothing is found within the bound it emits a
#       ::warning:: and an empty run-id, and exits 0. A failing gh call is a real
#       error and exits non-zero.
#   resolve-coverage-badge-run.sh keep-published <dest-dir> <file> <url>
#       Fallback when nothing was found: copy the currently published badge into
#       <dest-dir> so the deploy does not drop it. A missing published badge only
#       warns.
#
# Env: GITHUB_REPOSITORY (required for resolve), GH_BIN (default gh), CURL_BIN
# (default curl), BADGE_MAX_PAGES (default 40), BADGE_MAX_RUN_CHECKS (default 10).
set -euo pipefail

gh_bin="${GH_BIN:-gh}"
curl_bin="${CURL_BIN:-curl}"
max_pages="${BADGE_MAX_PAGES:-40}"
max_checks="${BADGE_MAX_RUN_CHECKS:-10}"
merge_workflow='.github/workflows/merge.yml'

emit_output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "$1" >> "$GITHUB_OUTPUT"
  else
    echo "$1"
  fi
}

resolve() {
  local name="$1" repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  local page=1 checked=0 page_json ids run_id run_json
  while ((page <= max_pages)); do
    if ! page_json="$("$gh_bin" api "repos/$repo/actions/artifacts?name=$name&per_page=100&page=$page")"; then
      echo "::error::Failed to list $name artifacts (page $page)" >&2
      return 1
    fi
    if [[ "$(jq '.artifacts | length' <<< "$page_json")" -eq 0 ]]; then
      break
    fi
    ids="$(jq -r '.artifacts[] | select(.expired == false and .workflow_run.head_branch == "main") | .workflow_run.id' <<< "$page_json")"
    while IFS= read -r run_id; do
      [[ -n "$run_id" ]] || continue
      if ((checked >= max_checks)); then
        break 2
      fi
      checked=$((checked + 1))
      if ! run_json="$("$gh_bin" api "repos/$repo/actions/runs/$run_id")"; then
        echo "::error::Failed to read run $run_id" >&2
        return 1
      fi
      if jq -e --arg path "$merge_workflow" '.path == $path and .conclusion == "success"' <<< "$run_json" > /dev/null; then
        emit_output "run-id=$run_id"
        return 0
      fi
    done <<< "$ids"
    page=$((page + 1))
  done
  echo "::warning::No successful On Merge run on main with a non-expired $name artifact was found (checked $checked runs, up to $max_pages pages); the docs deploy continues without refreshing that badge."
  emit_output "run-id="
}

keep_published() {
  local dest="$1" file="$2" url="$3"
  mkdir -p "$dest"
  if "$curl_bin" -fsS --connect-timeout 10 --max-time 20 -o "$dest/$file.tmp" "$url" && jq -e . "$dest/$file.tmp" > /dev/null 2>&1; then
    mv "$dest/$file.tmp" "$dest/$file"
    echo "Kept the currently published $file"
  else
    rm -f "$dest/$file.tmp"
    echo "::warning::Could not fetch the currently published $file from $url; it will be absent from this deploy."
  fi
}

usage() {
  echo "Usage: $0 resolve <artifact-name> | keep-published <dest-dir> <file> <url>" >&2
  exit 2
}

case "${1:-}" in
  resolve)
    [[ $# -eq 2 ]] || usage
    resolve "$2"
    ;;
  keep-published)
    [[ $# -eq 4 ]] || usage
    keep_published "$2" "$3" "$4"
    ;;
  *) usage ;;
esac
