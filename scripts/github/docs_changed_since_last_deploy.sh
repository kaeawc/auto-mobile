#!/usr/bin/env bash
#
# docs_changed_since_last_deploy.sh
#
# Decide whether the documentation site needs republishing. The docs deploy
# (.github/workflows/docs.yml) runs nightly, but an LFS-backed checkout + full
# MkDocs build + Pages deploy is wasteful (and spends the repo's LFS budget)
# when nothing that feeds the site has changed. This gate compares the docs
# source paths at HEAD against the commit that was last successfully deployed,
# and prints `changed=true|false` to $GITHUB_OUTPUT (falling back to stdout for
# local runs).
#
# "Last successfully deployed" is the head SHA of the most recent successful
# run of the docs workflow on main. A run only succeeds when its deploy job
# ran OR was skipped because docs were unchanged; in the skip case the site
# content still matches that SHA, so diffing docs paths against it is correct
# either way. When no prior successful run exists (first run, or the last run
# failed), we republish.
#
# A manual `workflow_dispatch` always republishes — the operator asked for it.
#
# Requires: gh (authenticated via GH_TOKEN), git, and a checkout with full
# history (fetch-depth: 0) so the last-deployed commit is reachable.
#
# Env:
#   GITHUB_EVENT_NAME  - the triggering event (workflow_dispatch forces republish)
#   GITHUB_REPOSITORY  - owner/repo, passed to gh so it does not depend on remotes
#   DOCS_WORKFLOW_FILE - workflow file to query for the last deploy (default docs.yml)
#   GITHUB_OUTPUT      - GitHub Actions step output file (optional; stdout otherwise)

set -euo pipefail

# Source paths whose changes require a rebuild of the published site. Keep in
# sync with what deploy_pages.py / mkdocs.yml actually consume: the docs tree,
# the MkDocs config, the two files copied into docs/ at build time, the MkDocs
# tooling/deploy script, and this workflow itself.
DOCS_PATHS=(
  "docs"
  "mkdocs.yml"
  "CHANGELOG.md"
  ".github/CONTRIBUTING.md"
  "scripts/github"
  ".github/workflows/docs.yml"
)

WORKFLOW_FILE="${DOCS_WORKFLOW_FILE:-docs.yml}"

emit() {
  # $1: true|false  $2: human-readable reason
  echo "changed=$1" >> "${GITHUB_OUTPUT:-/dev/stdout}"
  echo "[docs-changed] changed=$1 ($2)" >&2
}

if [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
  emit true "manual dispatch"
  exit 0
fi

gh_args=(run list --workflow "$WORKFLOW_FILE" --branch main --status success
  --limit 1 --json headSha --jq '.[0].headSha // empty')
if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  gh_args+=(--repo "$GITHUB_REPOSITORY")
fi

if ! last_sha="$(gh "${gh_args[@]}")"; then
  echo "[docs-changed] failed to query the most recent successful docs deploy" >&2
  exit 1
fi

if [[ -z "$last_sha" ]]; then
  emit true "no prior successful deploy"
  exit 0
fi

if ! git cat-file -e "${last_sha}^{commit}" 2>/dev/null; then
  emit true "last deployed commit ${last_sha} unreachable (shallow checkout?)"
  exit 0
fi

if git diff --quiet "$last_sha" HEAD -- "${DOCS_PATHS[@]}"; then
  emit false "no docs changes since ${last_sha}"
else
  emit true "docs changed since ${last_sha}"
fi
