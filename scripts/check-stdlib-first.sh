#!/usr/bin/env bash
#
# Require a short decision record when a PR adds a direct runtime, development,
# or optional dependency. This keeps a generic package from becoming the first answer when
# the standard library or an existing AutoMobile seam already fits.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_REF="${STDLIB_FIRST_BASE_REF:-origin/main}"

cd "$ROOT_DIR"

# shellcheck disable=SC1091 # Resolved relative to this script's location.
source "$ROOT_DIR/scripts/lib/vcs-diff.sh"

set +e
vcs_base_exists "$BASE_REF"
base_exists=$?
set -e
if [[ "$base_exists" -ne 0 ]]; then
  echo "error: stdlib-first check cannot resolve base ref '${BASE_REF}'" >&2
  exit 2
fi

BASE_PACKAGE_JSON="$(vcs_file_at_merge_base "$BASE_REF" package.json)"
CURRENT_PACKAGE_JSON="$(<package.json)"

base_dependencies="$(jq -r '(.dependencies // {} | keys[]) , (.devDependencies // {} | keys[]) , (.optionalDependencies // {} | keys[])' <<<"$BASE_PACKAGE_JSON" | sort -u)"
current_dependencies="$(jq -r '(.dependencies // {} | keys[]) , (.devDependencies // {} | keys[]) , (.optionalDependencies // {} | keys[])' <<<"$CURRENT_PACKAGE_JSON" | sort -u)"
added_dependencies="$(comm -13 <(printf '%s\n' "$base_dependencies") <(printf '%s\n' "$current_dependencies"))"

if [[ -z "$added_dependencies" ]]; then
  echo "stdlib-first: no new direct dependencies."
  exit 0
fi

missing=0
while IFS= read -r dependency; do
  [[ -z "$dependency" ]] && continue
  if ! rg --glob '*.md' --fixed-strings "Dependency: \`${dependency}\`" docs/decisions >/dev/null 2>&1; then
    echo "error: new direct dependency '${dependency}' needs a docs/decisions record containing: Dependency: \`${dependency}\`" >&2
    missing=1
  fi
done <<<"$added_dependencies"

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

echo "stdlib-first: every new direct dependency has a decision record."
