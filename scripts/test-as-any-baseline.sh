#!/usr/bin/env bash
#
# Count TypeScript `as any` assertions in test/ using the installed TypeScript
# parser. AST nodes distinguish assertions from comments and string literals;
# a text search cannot reliably do that (or handle multiline assertions).
# Like oxlint-baseline.sh, this is a per-file, one-way count ratchet.
#
# Usage:
#   scripts/test-as-any-baseline.sh                       # check mode
#   scripts/test-as-any-baseline.sh --update              # shrink baseline
#   scripts/test-as-any-baseline.sh --update --allow-grow # record intentional growth

set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Override for BATS fixtures; never touches the committed baseline in tests.
BASELINE="${TEST_AS_ANY_BASELINE:-$ROOT/scripts/test-as-any-baseline.txt}"
TEST_ROOT="${TEST_AS_ANY_ROOT:-$ROOT/test}"
cd "$ROOT"

MODE="check"
ALLOW_GROW="false"
for arg in "$@"; do
  case "$arg" in
    --update) MODE="update" ;;
    --allow-grow) ALLOW_GROW="true" ;;
    *) echo "Unknown argument: $arg (expected --update and/or --allow-grow)" >&2; exit 2 ;;
  esac
done
if [[ "$ALLOW_GROW" == "true" && "$MODE" != "update" ]]; then
  echo "--allow-grow is only valid with --update" >&2
  exit 2
fi

# Bun resolves the repo's installed TypeScript package. Emit only nonzero files
# as "<count>\t<filename>", sorted by filename for stable baseline diffs.
# shellcheck disable=SC2016 # JavaScript template interpolation is intentional.
current="$(bun -e '
  import ts from "typescript";
  import { Glob } from "bun";
  import { readFileSync, realpathSync } from "node:fs";
  import { relative, resolve } from "node:path";
  const root = process.cwd();
  // process.cwd() is already a real path (macOS /tmp -> /private/tmp), so
  // resolve symlinks here too or relative() yields ../../tmp/... keys.
  const testRoot = realpathSync(resolve(process.argv[1]));
  const rows: Array<[string, number]> = [];
  for (const path of new Glob("**/*.ts").scanSync({ cwd: testRoot })) {
    const absolute = resolve(testRoot, path);
    const source = ts.createSourceFile(path, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
    let count = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword) count++;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (count) rows.push([relative(root, absolute).replaceAll("\\", "/"), count]);
  }
  rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  process.stdout.write(rows.map(([file, count]) => `${count}\t${file}`).join("\n"));
' "$TEST_ROOT")"
current_total="$(printf '%s\n' "$current" | awk -F '\t' 'NF == 2 {s += $1} END {print s+0}')"

# Compare each current file with its old allowance, including newly added files.
new_or_increased() {
  awk -F '\t' '
    FNR == NR { if ($0 !~ /^#/ && NF == 2) allowed[$2] = $1; next }
    NF == 2 && $1 > allowed[$2] { print ($1 - allowed[$2]) " new in " $2 }
  ' "$BASELINE" <(printf '%s\n' "$current")
}

if [[ "$MODE" == "update" ]]; then
  if [[ -f "$BASELINE" && "$ALLOW_GROW" != "true" ]]; then
    grew="$(new_or_increased)"
    if [[ -n "$grew" ]]; then
      echo "refusing to grow the baseline: a file count increased or a new file appeared:" >&2
      printf '%s\n' "$grew" >&2
      echo "The test as-any ratchet is a one-way ratchet. If this growth is intended," >&2
      echo "re-run with: bun run test:as-any:baseline -- --allow-grow" >&2
      exit 1
    fi
  fi
  {
    echo "# AutoMobile test as-any ratchet baseline -- see scripts/test-as-any-baseline.sh"
    printf '%s\n' "$current"
  } > "$BASELINE"
  echo "Updated $BASELINE ($current_total gated assertion(s))."
  exit 0
fi

if [[ ! -f "$BASELINE" ]]; then
  echo "ERROR: baseline missing: $BASELINE" >&2
  echo "Generate it once with: bun run test:as-any:baseline" >&2
  exit 1
fi

grew="$(new_or_increased)"
if [[ -n "$grew" ]]; then
  echo "test as-any ratchet: NEW assertion(s) -- fix them or (rarely) record with --update:" >&2
  printf '%s\n' "$grew" >&2
  exit 1
fi
echo "test as-any ratchet gate: no new assertions ($current_total gated assertion(s) in baseline)."
