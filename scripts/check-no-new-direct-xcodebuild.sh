#!/usr/bin/env bash
set -euo pipefail

# Keep production xcodebuild execution behind XcodebuildClient. This is a
# diff-based ratchet: scripts and tests intentionally remain diagnostic tools.

base_ref="${1:-origin/main}"
owner="src/utils/ios-cmdline-tools/XcodebuildClient.ts"
changed_sources=()
# shellcheck disable=SC1091 # Resolved relative to this script's location.
source "$(dirname "${BASH_SOURCE[0]}")/lib/vcs-diff.sh"

if ! vcs_base_exists "$base_ref"; then
  printf 'Cannot check new xcodebuild calls: base ref %s does not exist.\n' "$(vcs_base_ref "$base_ref")" >&2
  exit 2
fi

while IFS= read -r file; do
  [[ "$file" == "$owner" || "$file" == test/* ]] && continue
  [[ -f "$file" ]] && changed_sources+=("$file")
done < <(vcs_changed_files "$base_ref" src)

bun "$(dirname "${BASH_SOURCE[0]}")/check-no-new-direct-xcodebuild.ts" \
  ${changed_sources[@]+"${changed_sources[@]}"}
