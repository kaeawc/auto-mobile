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
# Swap-guard (issue #3196, item 1): the fatal diff is a COUNT-based multiset, so
# it catches a second copy of a baselined signature but NOT a count-neutral SWAP
# (delete one pre-existing instance, add a different bug that normalizes to the
# same line:col-stripped signature). We cannot make the fatal key finer without
# reintroducing line-shift churn, so we record a per-signature COLUMN fingerprint
# in `# swap-fp:` comment lines and emit a NON-FATAL advisory when a count-stable
# signature's column set moves. See `swap_fingerprints()` below.
#
# Determinism: `tsgo` output (message text + which errors fire) is stable only for
# a FIXED compiler version. `@typescript/native-preview` is pinned to an EXACT
# version in package.json (no caret) precisely so a lockfile patch bump cannot
# silently flip the gate; the bump PR must pair the version change with
# `bun run typecheck:update` and commit the regenerated baseline. This matters
# more, not less, on a preview build: dev snapshots change diagnostics between
# dated releases. As defense in depth the baseline still records the compiler
# version it was generated with (`# generated-with:` header) and this gate warns
# loudly if the running tsgo ever differs.
#
# Base drift: the gate diffs against the committed baseline, so if `main` advances
# with a NEW error (or a second instance of an existing signature) after your
# baseline was committed, CI's merge-commit `tsc` can go red on a PR that did not
# introduce it. Resolve by rebasing onto `main` or re-running `--update`. (CI
# already gates this step on `ts_changed`, so native-only PRs skip it entirely.)
#
# Scope: `tsconfig.json` has `include: ["src"]`, so type errors under `test/**`
# are OUTSIDE this gate by design -- the class of bug it guards (a masked prod
# error) lives in `src/`. Extending coverage to tests would need a separate
# test-scoped tsconfig and its own baseline.
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

# Prefer the repo-local, pinned tsgo (TypeScript 7 native compiler). `bunx`
# resolves node_modules/.bin first when dependencies are installed (always true in
# CI); it only falls back to fetching when the repo has no local copy.
# TYPECHECK_TSC_CMD overrides the invocation -- used by the BATS tests to inject
# canned output. It is `eval`ed, so treat it as TRUSTED input only (never wire it
# from an untrusted source).
#
# TypeScript 7 removed the legacy `moduleResolution: node10` (which the old
# `"node"` value aliased to), so tsconfig.json was migrated to
# `module: ESNext` + `moduleResolution: bundler` -- the mode that matches how bun
# actually resolves this repo's extensionless imports, and the same config
# tsgolint reads for oxlint's `--type-aware` rules.
run_tsc() {
  if [[ -n "${TYPECHECK_TSC_CMD:-}" ]]; then
    eval "$TYPECHECK_TSC_CMD" 2>&1
  else
    bunx tsgo --noEmit -p tsconfig.json 2>&1
  fi
}

# Resolve the running tsgo version ("7.0.0-dev.20260707.2"), or "" when it cannot
# be determined (e.g. the BATS stub, which has no --version). TYPECHECK_TSC_VERSION
# overrides it for tests. An empty result disables the version-mismatch check
# (never blocks).
detect_tsc_version() {
  if [[ -n "${TYPECHECK_TSC_VERSION:-}" ]]; then
    printf '%s' "$TYPECHECK_TSC_VERSION"
  elif [[ -n "${TYPECHECK_TSC_CMD:-}" ]]; then
    printf ''
  else
    bunx tsgo --version 2>/dev/null | awk '{print $NF}' || true
  fi
}

# Absolute repo root escaped for use in a `sed` `s|...|` pattern. Some tsc
# diagnostics (TS2694/TS2345 `import("<abs>")`, TS1149, TS7016) embed the
# ABSOLUTE project path in the message, which differs per checkout
# (`/Users/...` locally vs `/home/runner/work/...` in CI). Stripping the local
# root makes those signatures path-independent so the baseline matches on any
# machine.
ROOT_SED_PATTERN="$(printf '%s' "$ROOT" | sed 's/[][\.*^$|/]/\\&/g')"

# Union-order canonicalization (issue #4211).
#
# `tsc` renders a union's members in the order their literal types were first
# instantiated across the program, NOT in declaration order. That instantiation
# order shifts when the module graph changes, so the SAME error under the SAME
# pinned tsc can render as
#     severity: "critical" | "high" | "medium" | "low"     (when baselined)
#     severity: "high" | "medium" | "critical" | "low"     (later)
# Because the signature embeds the rendered type text verbatim, a reordering made
# the baselined error read as NEW while the identical baselined one read as
# FIXED -- turning `main` red with no code change (issue #4211, and the reason
# issue #4209 was filed). The gate is meant to key on the ERROR, and `A | B` and
# `B | A` are the same type, so member order must not be part of the key.
#
# Each maximal run of `TOKEN ( " | " TOKEN )+` is byte-sorted in place. TOKEN is
# deliberately narrow -- a double-quoted string literal or a bare identifier --
# so a run whose members are complex (object literals, generics, template-literal
# types, numeric literals) is left ALONE rather than mis-parsed; leaving it alone
# is exactly today's behavior, so the conservative match can only preserve the
# status quo, never corrupt a signature. Runs are found independently, so
# adjacent unions separated by `;` are sorted separately and never bleed into
# one another.
#
# Runs are found by SCANNING, not by matching a run-shaped regex and re-splitting
# the match (issue #4257). Two things a regex split gets wrong, and both have
# turned `main` red before:
#   * a string-literal member may contain the separator (`"a | b" | "c"`), so a
#     text split on " | " cuts inside the quotes (issue #4229); and
#   * a member's VALUE may contain an ESCAPED quote (`"z" | "a\" | b" | "c"`), so
#     a `"[^"]*"` token stops at the `\"` and the literal's tail is re-read as
#     extra members -- writing the corrupted signature `"a\" | "z" | b" | "c"`.
#     That corruption is self-consistent, so a round trip passes; it only shows
#     up when the same union is re-rendered in a different order, i.e. exactly
#     the case union canonicalization exists to tolerate (issue #4257).
# The scanner therefore reads a string literal the way TypeScript renders one:
# quote, then a body of escape pairs (`\"`, `\\`, `\n`, ...) or plain non-quote
# non-backslash characters, then the closing quote. Anything that is not a
# complete literal or a bare identifier ends the run and is emitted verbatim.
#
# This is order-INSENSITIVE, not laxer: sorting is a canonical form, so two
# errors collide only when their union members are the same multiset -- i.e.
# when they are genuinely the same type. A union with a DIFFERENT member still
# produces a different signature and is still caught as new (pinned by the
# "different union members" BATS case).
#
# LC_ALL=C is exported at the top of this script, so the sort is byte-wise and
# identical on every machine.
canonicalize_unions() {
  awk '
    # Read ONE member anchored at the front of `rest`: either a complete
    # double-quoted string literal whose body understands backslash escapes
    # (so `\"` and `\\` stay inside the literal), or a bare identifier.
    # Returns its length in characters, or 0 when `rest` does not start with a
    # complete member -- which is how an unterminated quote, a template literal,
    # a numeric literal or an object type ends the run instead of being
    # mis-parsed.
    function member_len(rest) {
      if (match(rest, /^("(\\.|[^"\\])*"|[A-Za-z_$][A-Za-z0-9_$]*)/)) { return RLENGTH }
      return 0
    }
    function canon_unions(line,   out, pos, len, c, n, arr, i, j, t, joined, p, end, w) {
      out = ""
      pos = 1
      len = length(line)
      while (pos <= len) {
        c = substr(line, pos, 1)
        # Only a quote or an identifier-start character can begin a member;
        # everything else is copied through untouched.
        if (c != "\"" && c !~ /^[A-Za-z_$]$/) {
          out = out c
          pos++
          continue
        }
        # Walk `member ( " | " member )*` from here, remembering where the last
        # COMPLETE member ended so a dangling separator is never consumed.
        n = 0
        p = pos
        end = pos
        while (1) {
          w = member_len(substr(line, p))
          if (w == 0) { break }
          arr[++n] = substr(line, p, w)
          p += w
          end = p
          if (substr(line, p, 3) != " | ") { break }
          p += 3
        }
        if (n == 0) {
          # A quote that opens no complete literal: emit it and move on.
          out = out c
          pos++
          continue
        }
        if (n == 1) {
          out = out arr[1]
        } else {
          for (i = 1; i <= n; i++)
            for (j = i + 1; j <= n; j++)
              if (arr[i] > arr[j]) { t = arr[i]; arr[i] = arr[j]; arr[j] = t }
          joined = arr[1]
          for (i = 2; i <= n; i++) joined = joined " | " arr[i]
          out = out joined
        }
        pos = end
      }
      return out
    }
    { print canon_unions($0) }
  '
}

# Reduce raw tsc output to a sorted multiset of stable error signatures.
# 1. keep only top-level error lines (indented detail lines are dropped);
# 2. strip the "(line,col)" file location (first "(n,n)" only, via no /g flag),
#    so line shifts don't churn the baseline and message-embedded numbers survive;
# 3. strip the absolute repo-root prefix from message-embedded paths;
# 4. canonicalize union member order (issue #4211) so a re-rendered union does
#    not read as a new error.
# The `grep` is guarded with `|| true` so a clean tree (zero matching lines) does
# not abort the script under `set -o pipefail`.
normalize() {
  { grep -E '^[^[:space:]].*: error TS[0-9]+' || true; } \
    | sed -E 's/\(([0-9]+),([0-9]+)\)//' \
    | sed "s|${ROOT_SED_PATTERN}/||g" \
    | canonicalize_unions \
    | sort
}

# Swap-guard fingerprint (issue #3196, item 1). The fatal gate keys errors by the
# line:col-stripped signature and compares them as a multiset, so it catches a
# COUNT increase but NOT a count-neutral SWAP: within a file that already has N
# identical baselined signatures, deleting one pre-existing instance and adding a
# genuinely different bug that normalizes to the SAME signature keeps the count at
# N and hides the new bug. Line:col was stripped on purpose (line shifts would
# churn the baseline), so we cannot make the fatal key finer-grained.
#
# Instead we record, per stable signature, the sorted multiset of its COLUMNS as a
# `# swap-fp:` comment line. Columns move far less than lines under ordinary edits
# (they shift only when the offending token moves within its own line), so a
# CHANGED column-set on an otherwise count-stable signature is a strong swap hint.
# It is emitted as an advisory only (never fails the gate) and lives in a `#`
# comment, so it is invisible to `baseline_signatures()` and cannot perturb the
# fatal multiset diff or the ratchet.
#
# Format: `# swap-fp: <col>[,<col>...] :: <signature>` (columns byte-sorted). The
# signature half is the SAME normalized string the fatal gate uses, so the two
# stay in lock-step. Lines with an unparseable column are skipped.
swap_fingerprints() {
  { grep -E '^[^[:space:]].*: error TS[0-9]+' || true; } \
    | sed -E "s|${ROOT_SED_PATTERN}/||g" \
    | awk -F'\\(|,|\\):' '
        # $1=path  $2=line  $3=col  and the remainder is " error TSxxxx: message".
        {
          col = $3
          rest = $0
          sub(/^[^)]*\):/, "", rest)  # drop the leading "path(line,col):", keep the
                                       # remainder " error TSxxxx: message".
          sig = $1 ":" rest            # rebuild "path: error ..." exactly as normalize()
                                       # emits it (path colon retained, line:col gone).
          if (col ~ /^[0-9]+$/) cols[sig] = cols[sig] col ORS
        }
        END {
          for (sig in cols) {
            n = split(cols[sig], arr, ORS)
            # bubble the (small) column list into byte order for a stable key.
            for (i = 1; i <= n; i++)
              for (j = i + 1; j <= n; j++)
                if (arr[i] + 0 > arr[j] + 0) { t = arr[i]; arr[i] = arr[j]; arr[j] = t }
            joined = ""
            for (i = 1; i <= n; i++) if (arr[i] != "") joined = joined (joined == "" ? "" : ",") arr[i]
            if (joined != "") print "# swap-fp: " joined " :: " sig
          }
        }' \
    | canonicalize_unions \
    | sort
}

# Baseline signatures only, i.e. the committed file minus its `#` header lines.
#
# The stored signatures are canonicalized on READ as well as on write (issue
# #4211). `normalize()` now emits union members byte-sorted, so a baseline
# committed BEFORE that change still holds unsorted unions; canonicalizing here
# means such a baseline keeps matching instead of every union-bearing signature
# reading as simultaneously new and fixed. It is idempotent for a freshly
# written baseline, so the two paths cannot drift.
baseline_signatures() {
  { grep -v '^#' "$BASELINE" || true; } | canonicalize_unions
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
    # Count only real signature lines; `# swap-fp:` comment lines also contain
    # ": error TS" and must not inflate the ratchet's grow-check.
    prev_count="$(baseline_signatures | grep -c ': error TS' || true)"
    if [[ "$current_count" -gt "$prev_count" ]]; then
      echo "❌ refusing to grow the baseline: $prev_count -> $current_count error(s)." >&2
      echo "The typecheck baseline is a one-way ratchet. If this growth is truly" >&2
      echo "intended, re-run with:  bun run typecheck:update -- --allow-grow" >&2
      exit 1
    fi
  fi
  swap_fp="$(printf '%s\n' "$raw_tsc" | swap_fingerprints)"
  {
    echo "# AutoMobile typecheck baseline (issue #3001) -- see scripts/typecheck-baseline.sh"
    echo "# generated-with: tsgo ${tsc_version:-unknown}"
    printf '%s\n' "$current"
    # Swap-guard fingerprints (issue #3196): `#`-comment lines, ignored by the
    # fatal multiset diff, used only by the non-fatal swap advisory in check mode.
    printf '%s\n' "$swap_fp"
  } > "$BASELINE"
  echo "Updated $BASELINE ($current_count baseline error(s), tsgo ${tsc_version:-unknown})."
  exit 0
fi

if [[ ! -f "$BASELINE" ]]; then
  echo "ERROR: baseline missing: $BASELINE" >&2
  echo "Generate it once with: bun run typecheck:update" >&2
  exit 1
fi

# Warn (never fail) when the baseline was generated with a different tsgo version:
# message text can shift between versions and produce spurious new/fixed diffs.
baseline_version="$(sed -n 's/^# generated-with: tsgo //p' "$BASELINE" | head -1)"
if [[ -n "$tsc_version" && -n "$baseline_version" && "$tsc_version" != "$baseline_version" ]]; then
  echo "⚠️  typecheck baseline was generated with tsgo $baseline_version but tsgo $tsc_version is running." >&2
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
# Exclude `# swap-fp:` comment lines, which also match ": error TS".
baseline_count="$(baseline_signatures | grep -c ': error TS' || true)"

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

# Swap-guard advisory (issue #3196, item 1): the fatal gate above is count-based
# and cannot see a count-neutral swap. Compare the recorded column fingerprints
# against the current ones; a signature whose count is unchanged but whose column
# multiset moved is a likely swap. Advisory ONLY -- never changes the exit code,
# and silently no-ops for baselines generated before this field existed.
# Canonicalized on read for the same reason as `baseline_signatures()` (issue
# #4211): the signature half of a `# swap-fp:` line stored before canonicalization
# holds unsorted unions. Without this, every union-bearing fingerprint would look
# "moved" against the now-canonical current set and the advisory would fire on
# dozens of signatures at once -- noise that trains readers to ignore a guard
# whose whole value is being rare.
baseline_swap_fp="$({ grep -E '^# swap-fp: ' "$BASELINE" || true; } | canonicalize_unions)"
if [[ -n "$baseline_swap_fp" ]]; then
  current_swap_fp="$(printf '%s\n' "$raw_tsc" | swap_fingerprints)"
  swap_moved="$(comm -13 \
    <(printf '%s\n' "$baseline_swap_fp" | sort) \
    <(printf '%s\n' "$current_swap_fp" | sort) || true)"
  # Only flag a signature when its column set moved AND its occurrence count is
  # UNCHANGED (baseline == current). A count DECREASE is a partial fix (the ratchet
  # message below already celebrates it), not a swap; a count increase was already
  # caught by the fatal gate above. Comparing counts keeps the advisory to genuine
  # count-neutral swaps -- the exact blind spot the fatal multiset diff has.
  swap_hits=""
  while IFS= read -r fp_line; do
    [[ -z "$fp_line" ]] && continue
    sig="${fp_line#*:: }"
    base_n="$(printf '%s\n' "$baseline_sorted" | grep -Fxc "$sig" || true)"
    [[ "$base_n" -eq 0 ]] && continue          # not a baselined signature
    cur_n="$(printf '%s\n' "$current" | grep -Fxc "$sig" || true)"
    [[ "$cur_n" -ne "$base_n" ]] && continue   # count changed -> fix, not a swap
    swap_hits+="$sig"$'\n'
  done <<< "$swap_moved"
  if [[ -n "${swap_hits//[$'\n']/}" ]]; then
    echo "" >&2
    echo "⚠️  typecheck swap-guard: a baselined signature's column set changed while its" >&2
    echo "    count stayed the same. The fatal gate is count-based and cannot tell a" >&2
    echo "    genuinely-different bug that normalizes to the SAME signature from the one" >&2
    echo "    it replaced. Verify these are not hiding a new bug (issue #3196):" >&2
    printf '%s' "$swap_hits" | sort -u | sed 's/^/      /' >&2
    echo "    If they are legitimate line/column shifts, run: bun run typecheck:update" >&2
  fi
fi

echo "✅ typecheck gate: no new type errors ($baseline_count known error(s) in baseline)."
if [[ "$fixed_count" -gt 0 ]]; then
  echo ""
  echo "🎉 $fixed_count baseline error(s) no longer occur. Ratchet the baseline down:"
  echo "  bun run typecheck:update   # then commit scripts/typecheck-baseline.txt"
fi
