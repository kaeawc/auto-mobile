#!/usr/bin/env bash
set -euo pipefail

# Keep macOS security execution in SecurityClient. This is a diff ratchet: it
# permits no production exceptions because doctor and Xcode signing both use
# the same injected client. Test fixtures are outside the scanned src/ tree.
base_ref="${1:-origin/main}"
owner="src/utils/ios-cmdline-tools/SecurityClient.ts"
violations=()
# shellcheck disable=SC1091 # Resolved relative to this script's location.
source "$(dirname "${BASH_SOURCE[0]}")/lib/vcs-diff.sh"

if ! vcs_base_exists "$base_ref"; then
  if ! vcs_uses_jj && [[ "$base_ref" == 'origin/main' && "${GITHUB_ACTIONS:-}" == 'true' && -n "${GITHUB_BASE_REF:-}" ]]; then
    base_ref="origin/$GITHUB_BASE_REF"
    git fetch --no-tags --depth=1 origin \
      "refs/heads/$GITHUB_BASE_REF:refs/remotes/origin/$GITHUB_BASE_REF"
  fi

  if ! vcs_base_exists "$base_ref"; then
    printf 'Cannot check new security calls: base ref %s does not exist.\n' "$(vcs_base_ref "$base_ref")" >&2
    exit 2
  fi
fi

# Only SecurityClient may introduce a literal macOS security command. The
# conservative literal check covers argv, shell, absolute-path, Bun.spawn, and
# constructed-path forms without guessing which launch API receives it.
pattern="(\"|\\\`|')(/usr/bin/)?security([[:space:]]|\"|\\\`|')"

while IFS= read -r file; do
  [[ "$file" == "$owner" ]] && continue
  added_lines="$(vcs_diff "$base_ref" "$file" | awk '/^\+[^+]/ { printf "%s ", substr($0, 2) }')"
  [[ -z "$added_lines" ]] && continue
  if grep -Eq "$pattern" <<<"$added_lines"; then
    violations+=("$file")
  fi
done < <(vcs_changed_files "$base_ref" src)

if ((${#violations[@]})); then
  printf '%s\n' 'New production security execution must go through SecurityClient:' >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi
