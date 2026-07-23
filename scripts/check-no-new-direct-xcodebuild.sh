#!/usr/bin/env bash
set -euo pipefail

# Keep production xcodebuild execution behind XcodebuildClient. This is a
# diff-based ratchet: scripts and tests intentionally remain diagnostic tools.

base_ref="${1:-origin/main}"
owner="src/utils/ios-cmdline-tools/XcodebuildClient.ts"
violations=()

if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
  printf 'Cannot check new xcodebuild calls: base ref %s does not exist.\n' "$base_ref" >&2
  exit 2
fi

quote_pattern=$'["`\x27]'
direct_process_call='(spawn|spawnSync|execFile|execFileSync|exec|execSync)'
pattern="(${direct_process_call}\\([^;]*xcodebuild|(const|let|var)[^;=]*=[^;]*${quote_pattern}xcodebuild[^;]*;[[:space:]]*${direct_process_call}\\()"

while IFS= read -r file; do
  [[ "$file" == "$owner" || "$file" == test/* ]] && continue
  added_lines="$(git diff --unified=0 "$base_ref" -- "$file" | awk '/^\+[^+]/ { print substr($0, 2) }' | perl -0pe 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g' | tr '\n' ' ')"
  [[ -z "$added_lines" ]] && continue
  if grep -Eq "$pattern" <<<"$added_lines"; then
    violations+=("$file")
  fi
done < <(git diff --name-only "$base_ref" -- src)

if ((${#violations[@]})); then
  printf '%s\n' "New production xcodebuild execution must go through XcodebuildClient:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi

printf '%s\n' "xcodebuild-boundary: no new direct production xcodebuild invocations."
