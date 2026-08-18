#!/usr/bin/env bash
set -euo pipefail

# Prevent newly added production callers from bypassing SimCtlClient. Existing
# migration debt is intentionally not treated as a failure here: this check is
# a ratchet, while issue #4049 migrates callers incrementally.

base_ref="${1:-origin/main}"
owner="src/utils/ios-cmdline-tools/SimCtlClient.ts"
violations=()
# shellcheck disable=SC1091 # Resolved relative to this script's location.
source "$(dirname "${BASH_SOURCE[0]}")/lib/vcs-diff.sh"

if ! vcs_base_exists "$base_ref"; then
  # pull_request checkouts are shallow by default, so neither origin/main nor
  # HEAD^1 is guaranteed to exist. Fetch the actual PR base before comparing.
  if ! vcs_uses_jj && [[ "$base_ref" == 'origin/main' && "${GITHUB_ACTIONS:-}" == 'true' && -n "${GITHUB_BASE_REF:-}" ]]; then
    base_ref="origin/$GITHUB_BASE_REF"
    git fetch --no-tags --depth=1 origin \
      "refs/heads/$GITHUB_BASE_REF:refs/remotes/origin/$GITHUB_BASE_REF"
  fi

  if ! vcs_base_exists "$base_ref"; then
    printf 'Cannot check new simctl calls: base ref %s does not exist.\n' "$(vcs_base_ref "$base_ref")" >&2
    exit 2
  fi
fi

# Newlines are normalized below so argv calls formatted over multiple lines are
# checked as one expression. Block all direct xcrun argv calls outside the
# owner: variable argv values cannot be proven to be non-simctl statically,
# and the conservative boundary prevents an easy bypass.
pattern="((spawn|spawnSync|execFile|execFileSync)\\([[:space:]]*(\"|\`|')xcrun|exec(Sync)?\\([^)]*(\"|\`|')xcrun simctl|\"/bin/sh\".*xcrun simctl)"

while IFS= read -r file; do
  [[ "$file" == "$owner" ]] && continue
  [[ "$file" == test/* ]] && continue

  added_lines="$(vcs_diff "$base_ref" "$file" | awk '/^\+[^+]/ { printf "%s ", substr($0, 2) }')"
  [[ -z "$added_lines" ]] && continue

  if grep -Eq "$pattern" <<<"$added_lines"; then
    violations+=("$file")
  fi
done < <(vcs_changed_files "$base_ref" src)

if ((${#violations[@]})); then
  printf '%s\n' "New production xcrun simctl execution must go through SimCtlClient:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi
