#!/usr/bin/env bash
# Prints "<workflow>\t<job id>\t<job name>" for every job in pull_request.yml and
# merge.yml, so a refactor of the shared job bodies can prove the status check
# context names (built from the job name) did not change (#11872):
#
#   bash scripts/ci/workflow-check-contexts.sh > before.tsv
#   ...refactor...
#   bash scripts/ci/workflow-check-contexts.sh | diff before.tsv -
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
command -v yq >/dev/null || { echo "yq is required" >&2; exit 2; }
for wf in pull_request merge; do
  WF="$wf" yq -r '.jobs | to_entries[] | [strenv(WF), .key, (.value.name // .key)] | @tsv' \
    ".github/workflows/${wf}.yml"
done
