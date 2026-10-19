#!/usr/bin/env bash
#
# Scoped TypeScript type-check gate (issues #3001, #11787).
#
# Bun's bundler skips type-checking, so `bun build.ts` / `bun test` compile code
# that `tsgo` would reject. Two independent passes close that gap:
#
#   scripts/typecheck-baseline.sh                  src (tsconfig.json) -- NO baseline.
#       The src baseline reached zero and was deleted: any error fails the gate.
#   scripts/typecheck-baseline.sh --project=test   every test/**/*.ts (tsconfig.test.json)
#       against scripts/typecheck-test-baseline.txt, a one-way count ratchet.
#
# Test baseline format: COMPACT, one `<file> <TScode> <count>` row per file and
# error code (message text and line numbers are not recorded, so it does not
# churn on rewording or unrelated edits). A count may shrink; a higher count or
# a new file/code pair fails. `--update` (test project only) rewrites the
# baseline and REFUSES to grow the total unless `--allow-grow` is passed. When
# you fix errors the gate stays green and reminds you to `--update`.
#
# Determinism: `tsgo` output is stable only for a FIXED compiler version.
# `@typescript/native-preview` is pinned to an exact version in package.json; the
# bump PR must regenerate the baseline (`bun run typecheck:test:update`). The
# baseline records its compiler version (`# generated-with:` header) and the gate
# warns loudly if the running tsgo differs.
#
# Types guard: both projects resolve `bun:*` modules and the `Bun` global from
# `@types/bun` (tsconfig `types`). If that package is missing, tsgo reports
# TS2688 ("Cannot find type definition file") or TS2307 for a `bun:` module.
# Those are an environment failure, not code drift: the gate fails (exit 4) on
# them in every mode, including `--update`, so they can never be baselined.
#
# Usage:
#   scripts/typecheck-baseline.sh                         # src gate
#   scripts/typecheck-baseline.sh --project=test          # test gate (CI)
#   scripts/typecheck-baseline.sh --project=test --update            # regenerate (refuses to grow)
#   scripts/typecheck-baseline.sh --project=test --update --allow-grow

set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSCONFIG="tsconfig.json"
PROJECT="src"
BASELINE_OVERRIDE="${TYPECHECK_BASELINE:-}"
cd "$ROOT"

MODE="check"
ALLOW_GROW="false"
for arg in "$@"; do
  case "$arg" in
    --update) MODE="update" ;;
    --allow-grow) ALLOW_GROW="true" ;;
    --project=test)
      TSCONFIG="tsconfig.test.json"
      PROJECT="test"
      ;;
    *)
      echo "Unknown argument: $arg (expected --project=test, --update and/or --allow-grow)" >&2
      exit 2
      ;;
  esac
done
BASELINE="${BASELINE_OVERRIDE:-$ROOT/scripts/typecheck-test-baseline.txt}"
if [[ "$ALLOW_GROW" == "true" && "$MODE" != "update" ]]; then
  echo "--allow-grow is only valid with --update" >&2
  exit 2
fi
if [[ "$MODE" == "update" && "$PROJECT" != "test" ]]; then
  echo "--update is only valid with --project=test: the src gate has no baseline." >&2
  exit 2
fi

# Run a command the way an `if` condition would (errexit is ignored inside it)
# and record its exit status in RUN_STATUS.
RUN_STATUS=0
run_capture_status() {
  local run_rc=0
  "$@" || run_rc=$?
  RUN_STATUS="${run_rc}"
}

# TYPECHECK_TSC_CMD overrides the invocation -- used by the BATS tests to inject
# canned output. It is `eval`ed, so treat it as TRUSTED input only.
run_tsc() {
  # A subshell, so an `exit` inside an injected TYPECHECK_TSC_CMD ends only the
  # type-check, not this script.
  (
    if [[ -n "${TYPECHECK_TSC_CMD:-}" ]]; then
      eval "$TYPECHECK_TSC_CMD" 2>&1
    else
      bunx tsgo --noEmit -p "$TSCONFIG" 2>&1
    fi
  )
}

# The running tsgo version ("7.0.0-dev.20260707.2"), or "" when unknown (e.g. the
# BATS stub). TYPECHECK_TSC_VERSION overrides it for tests.
detect_tsc_version() {
  if [[ -n "${TYPECHECK_TSC_VERSION:-}" ]]; then
    printf '%s' "$TYPECHECK_TSC_VERSION"
  elif [[ -n "${TYPECHECK_TSC_CMD:-}" ]]; then
    printf ''
  else
    bunx tsgo --version 2>/dev/null | awk '{print $NF}' || true
  fi
}

# Top-level error lines only (indented detail lines and summaries are dropped).
error_lines() {
  { grep -E '^[^[:space:]].*\([0-9]+,[0-9]+\): error TS[0-9]+' || true; }
}

# Compact per-file/per-code counts: `<file> <TScode> <count>`.
compact_counts() {
  error_lines \
    | sed -E 's/^([^(]*)\([0-9]+,[0-9]+\): error (TS[0-9]+).*/\1 \2/' \
    | sort | uniq -c | awk '{print $2 " " $3 " " $1}' | sort
}

# Sum of the count column of compact rows on stdin.
compact_total() {
  awk '!/^#/ && NF == 3 { n += $3 } END { print n + 0 }'
}

# tsgo exits non-zero when it reports diagnostics, so capture the status.
tsc_output_file="$(mktemp)"
run_capture_status run_tsc > "$tsc_output_file"
tsc_status="$RUN_STATUS"
raw_tsc="$(<"$tsc_output_file")"
rm -f "$tsc_output_file"
errors="$(printf '%s\n' "$raw_tsc" | error_lines)"
error_count="$(printf '%s' "$errors" | grep -c . || true)"

# Fail closed: a non-zero exit with NO parseable errors means tsgo never ran.
if [[ "$tsc_status" -ne 0 && "$error_count" -eq 0 ]]; then
  echo "ERROR: tsgo exited $tsc_status without reporting any parseable errors." >&2
  echo "The type-checker likely failed to run. Raw output:" >&2
  printf '%s\n' "$raw_tsc" >&2
  exit 3
fi

# Types guard (see header): missing @types/bun must never read as ordinary drift.
env_failures="$(printf '%s\n' "$errors" | grep -E "error TS2688|error TS2307: Cannot find module 'bun[:']" || true)"
if [[ -n "$env_failures" ]]; then
  echo "ERROR: type definitions are not resolving (is @types/bun installed? run bun install):" >&2
  printf '%s\n' "$env_failures" | head -5 >&2
  exit 4
fi

if [[ "$PROJECT" == "src" ]]; then
  if [[ "$error_count" -gt 0 ]]; then
    echo "" >&2
    echo "❌ typecheck gate: $error_count TypeScript error(s) (the src project has no baseline):" >&2
    printf '%s\n' "$errors" >&2
    exit 1
  fi
  echo "✅ typecheck gate: no type errors."
  exit 0
fi

tsc_version="$(detect_tsc_version)"
rows="$(printf '%s\n' "$raw_tsc" | compact_counts)"
total="$(printf '%s\n' "$rows" | compact_total)"

if [[ "$MODE" == "update" ]]; then
  if [[ -f "$BASELINE" && "$ALLOW_GROW" != "true" ]]; then
    prev="$(compact_total < "$BASELINE")"
    if [[ "$total" -gt "$prev" ]]; then
      echo "❌ refusing to grow the baseline: $prev -> $total error(s)." >&2
      echo "Re-run with: bash scripts/typecheck-baseline.sh --project=test --update --allow-grow" >&2
      exit 1
    fi
  fi
  {
    echo "# AutoMobile test typecheck baseline (issue #11787) -- see scripts/typecheck-baseline.sh"
    echo "# generated-with: tsgo ${tsc_version:-unknown}"
    echo "# format: <file> <TScode> <count>"
    printf '%s\n' "$rows"
  } > "$BASELINE"
  echo "Updated $BASELINE ($total baseline error(s), tsgo ${tsc_version:-unknown})."
  exit 0
fi

if [[ ! -f "$BASELINE" ]]; then
  echo "ERROR: baseline missing: $BASELINE" >&2
  echo "Generate it once with: bun run typecheck:test:update" >&2
  exit 1
fi

baseline_version="$(sed -n 's/^# generated-with: tsgo //p' "$BASELINE" | head -1)"
if [[ -n "$tsc_version" && -n "$baseline_version" && "$tsc_version" != "$baseline_version" ]]; then
  echo "⚠️  tsgo version differs from the baseline (running $tsc_version, baseline $baseline_version)." >&2
  echo "    Diagnostics can differ between versions; regenerate in the TS-bump PR:" >&2
  echo "    bun run typecheck:test:update" >&2
fi

worse="$(awk 'NR == FNR { if (!/^#/ && NF == 3) base[$1 " " $2] = $3; next }
  { k = $1 " " $2; b = (k in base) ? base[k] : 0
    if ($3 > b) print k ": " b " -> " $3 }' "$BASELINE" <(printf '%s\n' "$rows"))"
if [[ -n "$worse" ]]; then
  echo "" >&2
  echo "❌ typecheck gate (test): error count grew for:" >&2
  printf '%s\n' "$worse" | sed 's/^/  /' >&2
  echo "Fix the error(s). If intended (rare): bash scripts/typecheck-baseline.sh --project=test --update --allow-grow" >&2
  exit 1
fi
prev_total="$(compact_total < "$BASELINE")"
echo "✅ typecheck gate (test): no new type errors ($prev_total known error(s) in baseline)."
if [[ "$total" -lt "$prev_total" ]]; then
  echo "🎉 $((prev_total - total)) baseline error(s) no longer occur. Ratchet down: bun run typecheck:test:update"
fi
