#!/usr/bin/env bash
#
# Scoped TypeScript type-check gate (issue #3001).
#
# Bun's bundler skips type-checking, so `bun build.ts` / `bun test` compile code
# that `tsc` would reject. Type errors therefore accumulate undetected -- a
# repo-wide `tsc --noEmit` currently reports ~550 of them. Fixing all of them at
# once is infeasible, so a plain `tsc --noEmit` gate cannot be turned on green.
#
# Instead we snapshot the CURRENT set of errors into a committed baseline
# (scripts/typecheck-baseline.txt) and fail only when a change introduces a NEW
# error that is not already in the baseline. The baseline is a one-way ratchet:
#   * You can never ADD to it without an explicit, reviewable edit (a NEW error
#     fails the gate; the only way to record it is to run `--update` on purpose).
#   * When you FIX errors the gate stays green and reminds you to `--update` so
#     the baseline shrinks. It is expected to trend toward zero.
#
# Signature normalization: each error is keyed by "path: error TSxxxx: message"
# with the "(line,col)" stripped, so the baseline does NOT churn when unrelated
# edits shift line numbers. Indented continuation/detail lines from multi-line
# diagnostics are dropped -- only the top-level error line is significant.
#
# Determinism: `tsc` output is stable for a fixed TypeScript version. The version
# is pinned via package.json/bun.lock, and the gate runs on the ubuntu
# `ts-code-coverage` CI job, so a locally regenerated baseline matches CI. If you
# see spurious diffs, confirm your installed TypeScript matches the pin.
#
# Usage:
#   scripts/typecheck-baseline.sh            # check mode (CI gate); fails on NEW errors
#   scripts/typecheck-baseline.sh --update   # regenerate the committed baseline

set -euo pipefail

# Byte-wise, locale-independent sort/compare so `comm` sees identical collation
# on every machine (macOS dev vs. ubuntu CI).
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# TYPECHECK_BASELINE overrides the baseline location (used by the BATS tests so
# they never touch the committed baseline).
BASELINE="${TYPECHECK_BASELINE:-$ROOT/scripts/typecheck-baseline.txt}"
cd "$ROOT"

MODE="check"
if [[ "${1:-}" == "--update" ]]; then
  MODE="update"
elif [[ -n "${1:-}" ]]; then
  echo "Unknown argument: $1 (expected no args or --update)" >&2
  exit 2
fi

# Prefer the repo-local, pinned tsc. `bunx` resolves node_modules/.bin first when
# dependencies are installed (always true in CI); it only falls back to fetching
# when the repo has no local copy. TYPECHECK_TSC_CMD overrides the invocation --
# used by the BATS tests to inject canned output, and handy for pointing at a
# specific tsc binary locally.
run_tsc() {
  if [[ -n "${TYPECHECK_TSC_CMD:-}" ]]; then
    eval "$TYPECHECK_TSC_CMD" 2>&1
  else
    bunx tsc --noEmit --ignoreDeprecations 6.0 2>&1
  fi
}

# Reduce raw tsc output to a sorted multiset of stable error signatures.
# `sed` without the /g flag rewrites only the FIRST "(n,n)" on the line -- the
# file location -- and never touches numbers inside the message text. The `grep`
# is guarded with `|| true` so a clean tree (zero matching lines) does not abort
# the script under `set -o pipefail`.
normalize() {
  { grep -E '^[^[:space:]].*: error TS[0-9]+' || true; } \
    | sed -E 's/\(([0-9]+),([0-9]+)\)//' \
    | sort
}

# tsc exits 0 on a clean check and non-zero (2) when it reports diagnostics --
# the normal case here -- so capture the status instead of letting `set -e` abort.
raw_tsc="$(run_tsc)" && tsc_status=0 || tsc_status=$?
current="$(printf '%s\n' "$raw_tsc" | normalize)"
current_count="$(printf '%s' "$current" | grep -c ': error TS' || true)"

# Fail closed: a non-zero exit with NO parseable errors means tsc never actually
# ran (missing dependency, bad flag, crash) -- do not let that slip through green
# as if the tree were clean. (A clean check is exit 0 with zero errors.)
if [[ "$tsc_status" -ne 0 && "$current_count" -eq 0 ]]; then
  echo "ERROR: tsc exited $tsc_status without reporting any parseable errors." >&2
  echo "The type-checker likely failed to run. Raw output:" >&2
  printf '%s\n' "$raw_tsc" >&2
  exit 3
fi

if [[ "$MODE" == "update" ]]; then
  printf '%s\n' "$current" > "$BASELINE"
  count="$(printf '%s\n' "$current" | grep -c ': error TS' || true)"
  echo "Updated $BASELINE ($count baseline error(s))."
  exit 0
fi

if [[ ! -f "$BASELINE" ]]; then
  echo "ERROR: baseline missing: $BASELINE" >&2
  echo "Generate it once with: bun run typecheck:update" >&2
  exit 1
fi

# Multiset diff: `comm` on two sorted streams compares line-by-line, so a
# signature present N times in current but M<N times in the baseline surfaces
# (N-M) times in the "new" column -- exactly the errors a change introduced.
baseline_sorted="$(sort "$BASELINE")"
new_errors="$(comm -13 <(printf '%s\n' "$baseline_sorted") <(printf '%s\n' "$current") || true)"
fixed_errors="$(comm -23 <(printf '%s\n' "$baseline_sorted") <(printf '%s\n' "$current") || true)"

new_count="$(printf '%s' "$new_errors" | grep -c ': error TS' || true)"
fixed_count="$(printf '%s' "$fixed_errors" | grep -c ': error TS' || true)"
baseline_count="$(grep -c ': error TS' "$BASELINE" || true)"

if [[ "$new_count" -gt 0 ]]; then
  echo "" >&2
  echo "❌ typecheck gate: $new_count NEW TypeScript error(s) not in the baseline:" >&2
  echo "" >&2
  printf '%s\n' "$new_errors" >&2
  echo "" >&2
  echo "Fix the error(s) above. If they are genuinely intended (rare), run" >&2
  echo "  bun run typecheck:update" >&2
  echo "and commit scripts/typecheck-baseline.txt so reviewers see the baseline grow." >&2
  exit 1
fi

echo "✅ typecheck gate: no new type errors ($baseline_count known error(s) in baseline)."
if [[ "$fixed_count" -gt 0 ]]; then
  echo ""
  echo "🎉 $fixed_count baseline error(s) no longer occur. Ratchet the baseline down:"
  echo "  bun run typecheck:update   # then commit scripts/typecheck-baseline.txt"
fi
