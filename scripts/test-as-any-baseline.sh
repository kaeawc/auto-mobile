#!/usr/bin/env bash
#
# Count TypeScript type assertions in test/ using the installed TypeScript
# parser, for two predicates that share this one-way ratchet:
#   any      `X as any`
#   unknown  `X as unknown as T` (the double cast, #11786)
# AST nodes distinguish assertions from comments and string literals; a text
# search cannot reliably do that (or handle multiline assertions). Like
# oxlint-baseline.sh, each is a per-file, one-way count ratchet with its own
# baseline (scripts/test-as-any-baseline.txt, scripts/test-unknown-cast-baseline.txt).
#
# Usage:
#   scripts/test-as-any-baseline.sh                       # check mode
#   scripts/test-as-any-baseline.sh --update              # shrink baselines
#   scripts/test-as-any-baseline.sh --update --allow-grow # record intentional growth

set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Overrides for BATS fixtures; never touch the committed baselines in tests.
ANY_BASELINE="${TEST_AS_ANY_BASELINE:-$ROOT/scripts/test-as-any-baseline.txt}"
if [[ -n "${TEST_UNKNOWN_CAST_BASELINE:-}" ]]; then
  UNKNOWN_BASELINE="$TEST_UNKNOWN_CAST_BASELINE"
elif [[ -n "${TEST_AS_ANY_BASELINE:-}" ]]; then
  UNKNOWN_BASELINE="${TEST_AS_ANY_BASELINE%.txt}.unknown.txt"
else
  UNKNOWN_BASELINE="$ROOT/scripts/test-unknown-cast-baseline.txt"
fi
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

# Run one predicate ("any" or "unknown") under a baseline file.
#   $1 kind  $2 baseline  $3 label  $4 noun (for the pass message)
# Bun resolves the repo's installed TypeScript package. Emit only nonzero files
# as "<count>\t<filename>", sorted by filename for stable baseline diffs.
run_ratchet() {
  local kind="$1" BASELINE="$2" label="$3" noun="$4" current current_total grew
  # shellcheck disable=SC2016 # JavaScript template interpolation is intentional.
  # Callers run this as `run_ratchet ... || status=1`, which disables `set -e` inside the function,
  # so a crashed counter must be turned into a failure explicitly. Otherwise an empty result reads
  # as "no assertions" and --update would wipe the baseline.
  current="$(bun -e '
    import ts from "typescript";
    import { Glob } from "bun";
    import { readFileSync, realpathSync } from "node:fs";
    import { relative, resolve } from "node:path";
    const root = process.cwd();
    // process.cwd() is already a real path (macOS /tmp -> /private/tmp), so
    // resolve symlinks here too or relative() yields ../../tmp/... keys.
    const testRoot = realpathSync(resolve(process.argv[1]));
    const kind = process.argv[2];
    const unwrap = (node: ts.Expression): ts.Expression =>
      ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
    const matches = (node: ts.Node): boolean => {
      if (!ts.isAsExpression(node)) return false;
      if (kind === "any") return node.type.kind === ts.SyntaxKind.AnyKeyword;
      const inner = unwrap(node.expression);
      return ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword;
    };
    const rows: Array<[string, number]> = [];
    for (const path of new Glob("**/*.ts").scanSync({ cwd: testRoot })) {
      const absolute = resolve(testRoot, path);
      const source = ts.createSourceFile(path, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
      let count = 0;
      const visit = (node: ts.Node): void => {
        if (matches(node)) count++;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (count) rows.push([relative(root, absolute).replaceAll("\\", "/"), count]);
    }
    rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    process.stdout.write(rows.map(([file, count]) => `${count}\t${file}`).join("\n"));
  ' "$TEST_ROOT" "$kind")" || {
    echo "ERROR: could not count $noun(s) under $TEST_ROOT; baseline left untouched" >&2
    return 1
  }
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
        echo "The $label is a one-way ratchet. If this growth is intended," >&2
        echo "re-run with: bun run test:as-any:baseline -- --allow-grow" >&2
        return 1
      fi
    fi
    {
      echo "# AutoMobile $label baseline -- see scripts/test-as-any-baseline.sh"
      printf '%s\n' "$current"
    } > "$BASELINE"
    echo "Updated $BASELINE ($current_total gated $noun(s))."
    return 0
  fi

  if [[ ! -f "$BASELINE" ]]; then
    echo "ERROR: baseline missing: $BASELINE" >&2
    echo "Generate it once with: bun run test:as-any:baseline" >&2
    return 1
  fi

  grew="$(new_or_increased)"
  if [[ -n "$grew" ]]; then
    echo "$label: NEW $noun(s) -- fix them or (rarely) record with --update:" >&2
    printf '%s\n' "$grew" >&2
    return 1
  fi
  echo "$label gate: no new ${noun}s ($current_total gated $noun(s) in baseline)."
}

# Run both ratchets so each reports, but without `|| status=1`: a function in an `||` list runs with
# `set -e` disabled, which is how a crashed counter used to read as success.
set +e
run_ratchet any "$ANY_BASELINE" "test as-any ratchet" "assertion"
status_any=$?
run_ratchet unknown "$UNKNOWN_BASELINE" "test unknown-cast ratchet" "double cast"
status_unknown=$?
set -e
if [[ "$status_any" -ne 0 || "$status_unknown" -ne 0 ]]; then
  exit 1
fi
