#!/usr/bin/env bash
set -euo pipefail

# Git version metadata must be resolved through GitMetadataClient. This is a
# diff ratchet: tests are outside src/, and production diagnostics must use the
# same owner so they preserve the timeout and graceful-fallback contract.
base_ref="${1:-origin/main}"
owner="src/utils/GitMetadataClient.ts"
violations=()

if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
  printf 'Cannot check new git metadata calls: base ref %s does not exist.\n' "$base_ref" >&2
  exit 2
fi

pattern="((spawn|spawnSync|execFile|execFileSync)\\([[:space:]]*(\"|\`|')git|exec(Sync)?\\([^)]*(\"|\`|')git([[:space:]]|\`|'))"

while IFS= read -r file; do
  [[ "$file" == "$owner" ]] && continue

  added_lines="$(git diff --unified=0 "$base_ref" -- "$file" | awk '/^\+[^+]/ { printf "%s ", substr($0, 2) }')"
  [[ -z "$added_lines" ]] && continue

  if grep -Eq "$pattern" <<<"$added_lines"; then
    violations+=("$file")
  fi
done < <(git diff --name-only "$base_ref" -- src)

if ((${#violations[@]})); then
  printf '%s\n' "New production git metadata execution must go through GitMetadataClient:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi
