#!/usr/bin/env bash
#
# Shared runner for the table-driven boundary scanner (issue #13219). Sourced by
# the per-boundary wrappers (check-no-new-direct-*.sh); the rows themselves live
# in scripts/lib/boundaryRows.ts.
#
# Usage: run_boundary_row <row-id> <label> <fetch-pr-base: 0|1> <base-ref>
# Exit: 0 clean, 1 violations, 2 base ref missing.

# shellcheck source=scripts/lib/vcs-diff.sh
source "$(dirname "${BASH_SOURCE[0]}")/vcs-diff.sh"

run_boundary_row() {
  local row_id="$1" label="$2" fetch_pr_base="$3" base_ref="$4"
  local scanner diff_file rc
  scanner="$(dirname "${BASH_SOURCE[0]}")/../check-boundary-row.ts"

  if ! vcs_base_exists "$base_ref"; then
    # pull_request checkouts are shallow by default, so neither origin/main nor
    # HEAD^1 is guaranteed to exist. Fetch the actual PR base before comparing.
    if [[ "$fetch_pr_base" == 1 ]] && ! vcs_uses_jj &&
      [[ "$base_ref" == 'origin/main' && "${GITHUB_ACTIONS:-}" == 'true' && -n "${GITHUB_BASE_REF:-}" ]]; then
      base_ref="$(vcs_fetch_pr_base "$GITHUB_BASE_REF" || printf '%s' "$base_ref")"
    fi

    if ! vcs_base_exists "$base_ref"; then
      printf 'Cannot check new %s calls: base ref %s does not exist.\n' "$label" "$(vcs_base_ref "$base_ref")" >&2
      return 2
    fi
  fi

  diff_file="$(mktemp)"
  if ! vcs_diff "$base_ref" src >"$diff_file"; then
    rm -f "$diff_file"
    printf 'Cannot check new %s calls: diff against %s failed.\n' "$label" "$base_ref" >&2
    return 2
  fi
  rc=0
  bun "$scanner" "$row_id" "$diff_file" || rc=$?
  rm -f "$diff_file"
  return "$rc"
}
