#!/usr/bin/env bash
set -euo pipefail

# Prevent newly added production callers from bypassing SimCtlClient. Existing
# migration debt is intentionally not treated as a failure here: this check is
# a ratchet, while issue #4049 migrates callers incrementally. Tests and
# diagnostics may opt out with an adjacent `simctl-boundary-exception:` comment
# that explains why the direct invocation is necessary.

base_ref="${1:-origin/main}"
owner="src/utils/ios-cmdline-tools/SimCtlClient.ts"
violations=()
pattern='(spawn\([[:space:]]*"xcrun"|exec\([^)]*"xcrun simctl|"/bin/sh".*xcrun simctl)'

while IFS= read -r file; do
  [[ "$file" == "$owner" ]] && continue
  [[ "$file" == test/* ]] && continue

  added_lines="$(git diff --unified=0 "$base_ref" -- "$file" | awk '/^\+[^+]/ { print substr($0, 2) }')"
  [[ -z "$added_lines" ]] && continue

  if grep -nE "$pattern" <<<"$added_lines" >/dev/null; then
    while IFS= read -r match; do
      violations+=("$file:$match")
    done < <(grep -nE "$pattern" <<<"$added_lines")
  fi
done < <(git diff --name-only "$base_ref" -- src)

if ((${#violations[@]})); then
  printf '%s\n' "New production xcrun simctl execution must go through SimCtlClient:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi
