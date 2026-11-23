#!/usr/bin/env bash
#
# Run the docs readability check (scripts/docs/check-readability.ts) on the
# docs pages this branch changed, so a pre-push run fails on the same enforced
# findings the CI "Docs Readability Report" job reports for those pages.
#
# Changed pages are the docs/**/*.md files that differ from the merge-base with
# DOCS_READABILITY_BASE_REF (default origin/main, falling back to main when
# origin/main is absent), plus staged, unstaged and untracked edits. Pages the
# branch does not touch are not checked, so findings already on main do not
# block an unrelated push. Exits 0 when no docs page changed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=scripts/lib/vcs-diff.sh
source "${PROJECT_ROOT}/scripts/lib/vcs-diff.sh"

cd "${PROJECT_ROOT}"

base="${DOCS_READABILITY_BASE_REF:-origin/main}"
set +e
vcs_base_exists "${base}"
base_status=$?
if [[ "${base_status}" -ne 0 && -z "${DOCS_READABILITY_BASE_REF:-}" ]]; then
  base="main"
  vcs_base_exists "${base}"
  base_status=$?
fi
vcs_uses_jj
uses_jj_status=$?
set -e
if [[ "${base_status}" -ne 0 ]]; then
  echo "docs-readability: base ref '${base}' does not resolve to a commit." >&2
  exit 2
fi

branch_changes="$(vcs_changed_files_since_merge_base "${base}" docs)"
worktree_changes=""
if [[ "${uses_jj_status}" -ne 0 ]]; then
  # jj's diff above already includes the working copy; git's covers commits only.
  worktree_changes="$(
    vcs_touched_files docs
    git ls-files --others --exclude-standard -- docs
  )"
fi

pages=()
while IFS= read -r path; do
  if [[ "${path}" == docs/*.md && -f "${path}" ]]; then
    pages+=("${path}")
  fi
done < <(printf '%s\n%s\n' "${branch_changes}" "${worktree_changes}" | sort -u)

if [[ "${#pages[@]}" -eq 0 ]]; then
  echo "docs-readability: no docs pages changed since the merge-base with ${base}."
  exit 0
fi

exec bun "${PROJECT_ROOT}/scripts/docs/check-readability.ts" --files "${pages[@]}"
