#!/usr/bin/env bash
#
# Fast, affected-file feedback for host integration changes before a push.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

# shellcheck source=scripts/lib/file-selection.sh disable=SC1091
source "$ROOT/scripts/lib/file-selection.sh"

base_ref="${AUTOMOBILE_INTEGRATION_TEST_BASE_REF:-origin/main}"

changed_since_base="$(collect_changed_since_sha "$ROOT" "$base_ref" '.*')"
touched_files="$(collect_touched_files "$ROOT" '.*')"
changed="$(printf '%s\n%s\n' "$changed_since_base" "$touched_files" | sort -u)"
integration_files=()
runtime_graph_changed=false

while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  relative="${file#"$ROOT/"}"
  case "$relative" in
    test/*.integration.test.ts)
      integration_files+=("$relative")
      ;;
  esac
  case "$relative" in
    package.json | bun.lock | scripts/release/pin-runtime-deps.ts | scripts/release/runtime-graph.json | scripts/release/lib/runtime-pins.ts | scripts/release/lib/runtime-roots.ts | scripts/ci/verify-pinned-runtime-graph.sh)
      runtime_graph_changed=true
      ;;
  esac
done <<< "$changed"

if [[ "${#integration_files[@]}" -eq 0 ]]; then
  echo "Integration tests: skipped (no changed test/**/*.integration.test.ts files versus ${base_ref})."
else
  echo "Integration tests: running ${#integration_files[@]} affected file(s)."
  bash scripts/test-ts.sh integration "${integration_files[@]+"${integration_files[@]}"}"
fi

if [[ "$runtime_graph_changed" == true ]]; then
  echo "Pinned runtime graph: running (runtime dependency inputs changed)."
  bash scripts/ci/verify-pinned-runtime-graph.sh
  bun scripts/release/pin-runtime-deps.ts --check
else
  echo "Pinned runtime graph: skipped (package.json, bun.lock, and pin-runtime-deps.ts unchanged)."
fi

echo "Pre-push integration summary complete."
