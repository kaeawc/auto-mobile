#!/usr/bin/env bash
# Print the commit a pull request's changed-file checks should diff against.
#
# Usage: resolve-pr-base.sh <base-sha>
#
# <base-sha> is the PR's base commit (`github.event.pull_request.base.sha`).
# Using the SHA, not `origin/<base_ref>`, keeps stacked PRs working: their base
# branch is not always fetched, and it is often deleted once the PR under it
# merges, while the base commit itself stays reachable on GitHub (#16972).
#
# When the commit is not in the local clone it is fetched from `origin` (the
# remote can be overridden with PR_BASE_REMOTE). Prints the full SHA on stdout.
# Exits 2 on a usage error and 1 when the commit cannot be resolved.
set -euo pipefail

usage() {
  echo "Usage: resolve-pr-base.sh <base-sha>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
base_sha="$1"
[[ "${base_sha}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "Base '${base_sha}' is not a full 40-character commit SHA." >&2
  exit 2
}
remote="${PR_BASE_REMOTE:-origin}"

if git rev-parse --verify --quiet "${base_sha}^{commit}"; then
  exit 0
fi

# A failed fetch is reported by the resolve check below, with the reason kept
# on stderr from git itself.
git fetch --no-tags --quiet "${remote}" "${base_sha}" >&2 || true

if git rev-parse --verify --quiet "${base_sha}^{commit}"; then
  exit 0
fi

echo "PR base commit ${base_sha} is not in this clone and could not be fetched from '${remote}'." >&2
exit 1
