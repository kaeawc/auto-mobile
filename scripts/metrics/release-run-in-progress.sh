#!/usr/bin/env bash
#
# Report whether a Prepare Release or Release workflow run is active in REPO.
#
# A metrics commit landing on main while Prepare Release verifies a release
# moves main under it (#18175), so the download-metrics workflow skips its
# commit while either workflow has a run that has not completed.
#
# Usage: release-run-in-progress.sh <owner/repo>
# Exit 0 and print "<workflow> run <id> is <status>" for the first active run;
# exit 1 when none is active; exit 2 on a usage or API error.
set -euo pipefail

if (($# != 1)); then
  echo "usage: $0 <owner/repo>" >&2
  exit 2
fi
repo="$1"

workflows=(prepare-release.yml release.yml)
# Every non-terminal run status the Actions API reports.
statuses=(in_progress queued waiting requested pending)

for workflow in "${workflows[@]}"; do
  for status in "${statuses[@]}"; do
    if ! run_id="$(gh api "repos/${repo}/actions/workflows/${workflow}/runs?status=${status}&per_page=1" \
      --jq '.workflow_runs[0].id // empty')"; then
      echo "Failed to list ${workflow} runs with status ${status}" >&2
      exit 2
    fi
    if [[ -n "$run_id" ]]; then
      echo "${workflow} run ${run_id} is ${status}"
      exit 0
    fi
  done
done
exit 1
