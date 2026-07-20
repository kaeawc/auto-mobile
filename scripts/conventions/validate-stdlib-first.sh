#!/usr/bin/env bash
# Enforce only high-confidence convention violations. This complements
# ShellCheck; it intentionally does not judge legitimate stream processing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
violations=0

report() {
  printf '[stdlib-first] %s\n  %s\n' "$1" "$2" >&2
  violations=$((violations + 1))
}

# The retired helper parsed TypeScript with awk. Keep the ban exact so it
# cannot silently return through a copied workflow fragment.
while IFS= read -r -d '' file; do
  if grep -nE 'read_registry_field|read-registry-field\.sh' "$file" | grep -v 'convention-ok' >&2; then
    report "$file" "Use scripts/read-release-registry.ts instead of text-parsing release.ts. Add '# convention-ok: reason' only for a migration fixture."
  fi
done < <(find "$ROOT/scripts" "$ROOT/.github" -type f \( -name '*.sh' -o -name '*.yml' \) -print0)

if [ "$violations" -gt 0 ]; then
  exit 1
fi
echo "No stdlib-first convention violations found."
