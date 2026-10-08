#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/vcs-diff.sh disable=SC1091
source scripts/lib/vcs-diff.sh
default_base=origin/main
if [[ "${GITHUB_ACTIONS:-}" == true && -n "${GITHUB_BASE_REF:-}" ]]; then
  default_base="origin/$GITHUB_BASE_REF"
fi
base_ref="${1:-$default_base}"
# Predicate failures mean absent refs and are explicitly handled below.
# shellcheck disable=SC2310
if ! vcs_base_exists "$base_ref"; then
  # vcs_uses_jj is a boolean filesystem predicate, not an operation.
  # shellcheck disable=SC2310
  if ! vcs_uses_jj && [[ "${GITHUB_ACTIONS:-}" == true && -n "${GITHUB_BASE_REF:-}" && "$base_ref" == "origin/$GITHUB_BASE_REF" ]]; then
    base_ref="$(vcs_fetch_pr_base "$GITHUB_BASE_REF" || printf '%s' "$base_ref")"
  fi
  # shellcheck disable=SC2310 # Deliberately test ref existence after fetching.
  if ! vcs_base_exists "$base_ref"; then
    echo "Cannot check element-resolution ratchet: missing base $base_ref" >&2
    exit 2
  fi
fi
baseline_path=test/features/element-resolution/observeContractGaps.json
signature_path=test/features/element-resolution/observeContractGapSignatures.json
case_path=test/features/element-resolution/observeContractCaseKeys.json
scratch_dir="$(mktemp -d)"
trap 'rm -rf "$scratch_dir"' EXIT
# Resolve the merge base separately so an unavailable history fails closed.
# shellcheck disable=SC2310 # Boolean repository-kind predicate.
if vcs_uses_jj; then
  merge_base="$(jj log -r "fork_point(@ | $(vcs_base_ref "$base_ref"))" --no-graph -T commit_id)"
  jj file list -r "$merge_base" > "$scratch_dir/files"
else
  merge_base="$(git merge-base "$base_ref" HEAD)"
  git ls-tree -r --name-only "$merge_base" > "$scratch_dir/files"
fi
if grep -Fxq "$baseline_path" "$scratch_dir/files"; then
  vcs_file_at_merge_base "$base_ref" "$baseline_path" > "$scratch_dir/baseline.json"
  baseline_arg="$scratch_dir/baseline.json"
else
  baseline_arg=""
fi
if grep -Fxq "$signature_path" "$scratch_dir/files"; then
  vcs_file_at_merge_base "$base_ref" "$signature_path" > "$scratch_dir/signatures.json"
  signature_base_arg="$scratch_dir/signatures.json"
else
  signature_base_arg=""
fi
if grep -Fxq "$case_path" "$scratch_dir/files"; then
  vcs_file_at_merge_base "$base_ref" "$case_path" > "$scratch_dir/cases.json"
  case_base_arg="$scratch_dir/cases.json"
else
  case_base_arg=""
fi
# Only inception may lack these files; the TS gate pins reviewed seed digests.
bun scripts/check-element-resolution-ratchet.ts "$baseline_path" "$baseline_arg" "$signature_path" "$signature_base_arg" "$case_path" "$case_base_arg"
