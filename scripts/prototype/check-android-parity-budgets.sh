#!/usr/bin/env bash
# Fail when a web-vs-Android parity budget rises against the merge-base (#16610).
# The comparison lives in check-android-parity-budgets.ts; this wrapper only
# resolves the merge-base inputs, so it needs no browser.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: scripts/prototype/check-android-parity-budgets.sh [--base-ref <ref>]

Compare test/fixtures/prototype-web/android-parity-budgets.json in the working
tree with its value at the merge-base with the base ref (default origin/main, or
origin/$GITHUB_BASE_REF on a GitHub pull request). Lowering or removing a budget
passes, and so does a new budget for a golden that is new on this branch.
Raising a budget, or budgeting a golden that already existed, fails unless a
commit on the branch carries a trailer naming that golden:

  Parity-Budget-Grow: <golden>[, <golden>...]
HELP
}

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/lib/vcs-diff.sh
source scripts/lib/vcs-diff.sh

base_ref=origin/main
if [[ "${GITHUB_ACTIONS:-}" == true && -n "${GITHUB_BASE_REF:-}" ]]; then
  base_ref="origin/$GITHUB_BASE_REF"
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-ref)
      [[ $# -ge 2 ]] || { echo 'error: --base-ref requires a ref' >&2; exit 2; }
      base_ref="$2"
      shift 2
      ;;
    --help | -h) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

readonly budgets_path=test/fixtures/prototype-web/android-parity-budgets.json
if [[ ! -f "$budgets_path" ]]; then
  echo "No $budgets_path in this tree; nothing to check."
  exit 0
fi

# Predicate failures mean jj absence or an absent ref, handled explicitly below.
set +e
vcs_uses_jj
jj_status=$?
vcs_base_exists "$base_ref"
base_status=$?
set -e
if [[ "$base_status" -ne 0 && "${GITHUB_ACTIONS:-}" == true && -n "${GITHUB_BASE_REF:-}" && "$jj_status" -ne 0 ]]; then
  set +e
  fetched_base="$(vcs_fetch_pr_base "$GITHUB_BASE_REF")"
  fetch_status=$?
  set -e
  if [[ "$fetch_status" -eq 0 ]]; then base_ref="$fetched_base"; fi
  set +e
  vcs_base_exists "$base_ref"
  base_status=$?
  set -e
fi
if [[ "$base_status" -ne 0 ]]; then
  echo "error: cannot check Android parity budgets: missing base $base_ref" >&2
  exit 2
fi

scratch_dir="$(mktemp -d)"
trap 'rm -rf "$scratch_dir"' EXIT

# Resolve the merge-base separately so an unavailable history fails closed.
if [[ "$jj_status" -eq 0 ]]; then
  merge_base="$(jj log -r "fork_point(@ | $(vcs_base_ref "$base_ref"))" --no-graph -T commit_id)"
  jj file list -r "$merge_base" > "$scratch_dir/base-files"
  : > "$scratch_dir/trailers"
  while IFS= read -r commit; do
    [[ -n "$commit" ]] || continue
    jj log -r "$commit" --no-graph -T description | git interpret-trailers --parse >> "$scratch_dir/trailers"
  done < <(jj log -r "${merge_base}..@" --no-graph -T 'commit_id ++ "\n"')
else
  merge_base="$(git merge-base "$base_ref" HEAD)"
  git ls-tree -r --name-only "$merge_base" > "$scratch_dir/base-files"
  git log --format='%(trailers:key=Parity-Budget-Grow)' "${merge_base}..HEAD" > "$scratch_dir/trailers"
fi

base_args=()
if grep -Fxq "$budgets_path" "$scratch_dir/base-files"; then
  vcs_file_at_merge_base "$base_ref" "$budgets_path" > "$scratch_dir/base.json"
  base_args=(--base "$scratch_dir/base.json")
fi

bun scripts/prototype/check-android-parity-budgets.ts \
  --current "$budgets_path" \
  --base-files "$scratch_dir/base-files" \
  --trailers "$scratch_dir/trailers" \
  ${base_args[@]+"${base_args[@]}"}
