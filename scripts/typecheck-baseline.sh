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
#   * A NEW error fails the gate; the only way to record it is to run `--update`,
#     and `--update` REFUSES to write a larger baseline unless `--allow-grow` is
#     passed -- so the count cannot silently climb.
#   * When you FIX errors the gate stays green and reminds you to `--update` so
#     the baseline shrinks. It is expected to trend toward zero.
#
# Signature normalization: each error is keyed by "path: error TSxxxx: message"
# with the "(line,col)" stripped, so the baseline does NOT churn when unrelated
# edits shift line numbers. Indented continuation/detail lines from multi-line
# diagnostics are dropped -- only the top-level error line is significant.
#
# Determinism: `tsc` output (message text + which errors fire) is stable only for
# a FIXED TypeScript version. package.json uses a caret range, so a lockfile bump
# to a new tsc patch can change the error set with no source change. The baseline
# records the tsc version it was generated with (`# generated-with:` header) and
# this gate warns loudly when the running tsc differs -- regenerate the baseline
# (`bun run typecheck:update`) in the same PR that bumps TypeScript.
#
# Base drift: the gate diffs against the committed baseline, so if `main` advances
# with a NEW error (or a second instance of an existing signature) after your
# baseline was committed, CI's merge-commit `tsc` can go red on a PR that did not
# introduce it. Resolve by rebasing onto `main` or re-running `--update`.
#
# Usage:
#   scripts/typecheck-baseline.sh                     # check mode (CI gate)
#   scripts/typecheck-baseline.sh --update            # regenerate (refuses to grow)
#   scripts/typecheck-baseline.sh --update --allow-grow  # regenerate, allow growth

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
ALLOW_GROW="false"
for arg in "$@"; do
  case "$arg" in
    --update) MODE="update" ;;
    --allow-grow) ALLOW_GROW="true" ;;
    *)
      echo "Unknown argument: $arg (expected --update and/or --allow-grow)" >&2
      exit 2
      ;;
  esac
done
if [[ "$ALLOW_GROW" == "true" && "$MODE" != "update" ]]; then
  echo "--allow-grow is only valid with --update" >&2
  exit 2
fi

# Prefer the repo-local, pinned tsc. `bunx` resolves node_modules/.bin first when
# dependencies are installed (always true in CI); it only falls back to fetching
# when the repo has no local copy. TYPECHECK_TSC_CMD overrides the invocation --
# used by the BATS tests to inject canned output. It is `eval`ed, so treat it as
# TRUSTED input only (never wire it from an untrusted source).
run_tsc() {
  if [[ -n "${TYPECHECK_TSC_CMD:-}" ]]; then
    eval "$TYPECHECK_TSC_CMD" 2>&1
  else
    bunx tsc --noEmit --ignoreDeprecations 6.0 2>&1
  fi
}

# Resolve the running tsc version ("6.0.3"), or "" when it cannot be determined
# (e.g. the BATS stub, which has no --version). TYPECHECK_TSC_VERSION overrides it
# for tests. An empty result disables the version-mismatch check (never blocks).
detect_tsc_version() {
  if [[ -n "${TYPECHECK_TSC_VERSION:-}" ]]; then
    printf '%s' "$TYPECHECK_TSC_VERSION"
  elif [[ -n "${TYPECHECK_TSC_CMD:-}" ]]; then
    printf ''
  else
    bunx tsc --version 2>/dev/null | awk '{print $NF}' || true
  fi
}

# Absolute repo root escaped for use in a `sed` `s|...|` pattern. Some tsc
# diagnostics (TS2694/TS2345 `import("<abs>")`, TS1149, TS7016) embed the
# ABSOLUTE project path in the message, which differs per checkout
# (`/Users/...` locally vs `/home/runner/work/...` in CI). Stripping the local
# root makes those signatures path-independent so the baseline matches on any
# machine.
ROOT_SED_PATTERN="$(printf '%s' "$ROOT" | sed 's/[][\.*^$|/]/\\&/g')"

# Reduce raw tsc output to a sorted multiset of stable error signatures.
# 1. keep only top-level error lines (indented detail lines are dropped);
# 2. strip the "(line,col)" file location (first "(n,n)" only, via no /g flag),
#    so line shifts don't churn the baseline and message-embedded numbers survive;
# 3. strip the absolute repo-root prefix from message-embedded paths.
# The `grep` is guarded with `|| true` so a clean tree (zero matching lines) does
# not abort the script under `set -o pipefail`.
normalize() {
  { grep -E '^[^[:space:]].*: error TS[0-9]+' || true; } \
    | sed -E 's/\(([0-9]+),([0-9]+)\)//' \
    | sed "s|${ROOT_SED_PATTERN}/||g" \
    | sort
}

# Baseline signatures only, i.e. the committed file minus its `#` header lines.
baseline_signatures() {
  grep -v '^#' "$BASELINE" || true
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

tsc_version="$(detect_tsc_version)"

if [[ "$MODE" == "update" ]]; then
  # Enforce the ratchet: refuse to grow the baseline unless explicitly allowed.
  if [[ -f "$BASELINE" && "$ALLOW_GROW" != "true" ]]; then
    prev_count="$(grep -c ': error TS' "$BASELINE" || true)"
    if [[ "$current_count" -gt "$prev_count" ]]; then
      echo "❌ refusing to grow the baseline: $prev_count -> $current_count error(s)." >&2
      echo "The typecheck baseline is a one-way ratchet. If this growth is truly" >&2
      echo "intended, re-run with:  bun run typecheck:update -- --allow-grow" >&2
      exit 1
    fi
  fi
  {
    echo "# AutoMobile typecheck baseline (issue #3001) -- see scripts/typecheck-baseline.sh"
    echo "# generated-with: tsc ${tsc_version:-unknown}"
    printf '%s\n' "$current"
  } > "$BASELINE"
  echo "Updated $BASELINE ($current_count baseline error(s), tsc ${tsc_version:-unknown})."
  exit 0
fi

if [[ ! -f "$BASELINE" ]]; then
  echo "ERROR: baseline missing: $BASELINE" >&2
  echo "Generate it once with: bun run typecheck:update" >&2
  exit 1
fi

# Warn (never fail) when the baseline was generated with a different tsc version:
# message text can shift between versions and produce spurious new/fixed diffs.
baseline_version="$(sed -n 's/^# generated-with: tsc //p' "$BASELINE" | head -1)"
if [[ -n "$tsc_version" && -n "$baseline_version" && "$tsc_version" != "$baseline_version" ]]; then
  echo "⚠️  typecheck baseline was generated with tsc $baseline_version but tsc $tsc_version is running." >&2
  echo "    Diagnostic text can differ between versions; regenerate in the TS-bump PR:" >&2
  echo "    bun run typecheck:update" >&2
fi

# Multiset diff: `comm` on two sorted streams compares line-by-line, so a
# signature present N times in current but M<N times in the baseline surfaces
# (N-M) times in the "new" column -- exactly the errors a change introduced.
baseline_sorted="$(baseline_signatures | sort)"
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
