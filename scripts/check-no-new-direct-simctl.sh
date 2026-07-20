#!/usr/bin/env bash
set -euo pipefail

# Prevent newly added production callers from bypassing SimCtlClient. Existing
# migration debt is intentionally not treated as a failure here: this check is
# a ratchet, while issue #4049 migrates callers incrementally.

base_ref="${1:-origin/main}"
owner="src/utils/ios-cmdline-tools/SimCtlClient.ts"
violations=()

if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
  printf 'Cannot check new simctl calls: base ref %s does not exist.\n' "$base_ref" >&2
  exit 2
fi

# Newlines are normalized below so argv calls formatted over multiple lines are
# checked as one expression. `execFile`/`spawn` only match when their xcrun argv
# begins with `simctl`, avoiding unrelated xcrun tools such as `devicectl`.
pattern='((spawn|execFile)\([[:space:]]*"xcrun"[[:space:]]*,[[:space:]]*\[[[:space:]]*"simctl"|exec\([^)]*"xcrun simctl|"/bin/sh".*xcrun simctl)'

while IFS= read -r file; do
  [[ "$file" == "$owner" ]] && continue
  [[ "$file" == test/* ]] && continue

  added_lines="$(git diff --unified=0 "$base_ref" -- "$file" | awk '/^\+[^+]/ { printf "%s ", substr($0, 2) }')"
  [[ -z "$added_lines" ]] && continue

  if grep -Eq "$pattern" <<<"$added_lines"; then
    violations+=("$file")
  fi
done < <(git diff --name-only "$base_ref" -- src)

if ((${#violations[@]})); then
  printf '%s\n' "New production xcrun simctl execution must go through SimCtlClient:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi
