#!/usr/bin/env bats
#
# Tests for scripts/typecheck-baseline.sh -- the scoped `tsgo --noEmit` gate
# (issue #3001). The gate snapshots the existing type errors into a committed
# baseline and fails only on NEW errors, so the core logic under test is the
# multiset diff between fresh tsgo output and the baseline.
#
# tsgo is stubbed via TYPECHECK_TSC_CMD so the tests are fast and deterministic --
# they never invoke a real compiler. The baseline is redirected to a temp file
# via TYPECHECK_BASELINE so the committed baseline is never touched.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/typecheck-baseline.sh"

  TEST_DIR="$(mktemp -d)"
  export TYPECHECK_BASELINE="$TEST_DIR/baseline.txt"

  # Canned tsc output: two real error lines plus a multi-line diagnostic whose
  # indented detail line must be ignored, plus a trailing summary line.
  FIXTURE_TSC='printf "%s\n" \
    "src/a.ts(10,5): error TS2339: Property (x) does not exist on type (Y)." \
    "src/b.ts(3,1): error TS2345: Argument of type (string) is not assignable to parameter of type (number)." \
    "src/c.ts(7,2): error TS2769: No overload matches this call." \
    "  The last overload gave the following error." \
    "Found 3 errors in 3 files."'
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "update mode writes a normalized baseline (line:col stripped, details dropped)" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]

  # Three top-level errors captured; the indented detail and summary are dropped.
  # Count only signature lines -- `# swap-fp:` comments also contain ": error TS".
  run bash -c "grep -v '^#' '$TYPECHECK_BASELINE' | grep -c ': error TS'"
  [ "$output" -eq 3 ]

  # A provenance header is written so version drift can be detected later.
  grep -q '^# generated-with: tsgo' "$TYPECHECK_BASELINE"

  # (line,col) is stripped so line shifts do not churn the baseline.
  run grep -c '(10,5)' "$TYPECHECK_BASELINE"
  [ "$output" -eq 0 ]
  grep -q '^src/a.ts: error TS2339:' "$TYPECHECK_BASELINE"
}

@test "update refuses to grow the baseline without --allow-grow" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update

  local more="$FIXTURE_TSC"' && printf "%s\n" "src/z.ts(2,2): error TS2322: Type (a) is not assignable to type (b)."'
  TYPECHECK_TSC_CMD="$more" run bash "$SCRIPT" --update
  [ "$status" -eq 1 ]
  [[ "$output" == *"refusing to grow"* ]]

  # Baseline is left untouched at the original count (signature lines only).
  run bash -c "grep -v '^#' '$TYPECHECK_BASELINE' | grep -c ': error TS'"
  [ "$output" -eq 3 ]

  # --allow-grow lets it through.
  TYPECHECK_TSC_CMD="$more" run bash "$SCRIPT" --update --allow-grow
  [ "$status" -eq 0 ]
  run bash -c "grep -v '^#' '$TYPECHECK_BASELINE' | grep -c ': error TS'"
  [ "$output" -eq 4 ]
}

@test "check warns (non-fatal) when tsgo version differs from the baseline" {
  TYPECHECK_TSC_VERSION="6.0.3" TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update

  TYPECHECK_TSC_VERSION="9.9.9" TYPECHECK_TSC_CMD="$FIXTURE_TSC" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"generated with tsgo 6.0.3 but tsgo 9.9.9"* ]]
  [[ "$output" == *"no new type errors"* ]]
}

@test "normalize strips the absolute repo root from message-embedded paths" {
  # tsc embeds ABSOLUTE paths in some diagnostics (TS2694/TS2345 import("<abs>")).
  # Those differ per checkout (/Users locally vs /home/runner in CI), so they must
  # be stripped to a relative form or the baseline can never match across machines.
  local abs="$REPO_ROOT/src/features/observe/DeviceService"
  TYPECHECK_TSC_CMD="printf '%s\\n' \"src/x.ts(1,1): error TS2694: Namespace '$abs' has no exported member.\"" \
    run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]

  # No absolute path leaks into the committed baseline...
  run grep -c "$REPO_ROOT" "$TYPECHECK_BASELINE"
  [ "$output" -eq 0 ]
  # ...and the path survives in relative form.
  grep -q "Namespace 'src/features/observe/DeviceService'" "$TYPECHECK_BASELINE"
}

@test "check mode passes when current output matches the baseline" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new type errors"* ]]
}

@test "check mode FAILS and lists a newly introduced error" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update

  # Same output plus one brand-new error on a different file.
  local with_new="$FIXTURE_TSC"' && printf "%s\n" "src/new.ts(1,1): error TS2322: Type (a) is not assignable to type (b)."'
  TYPECHECK_TSC_CMD="$with_new" run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"1 NEW TypeScript error"* ]]
  [[ "$output" == *"src/new.ts: error TS2322"* ]]
}

@test "check mode catches a second same-signature error (count increase)" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update

  # A second occurrence of an already-baselined signature at a different line is
  # a NEW error -- the multiset diff must not let it hide behind the first.
  local dup="$FIXTURE_TSC"' && printf "%s\n" "src/a.ts(99,9): error TS2339: Property (x) does not exist on type (Y)."'
  TYPECHECK_TSC_CMD="$dup" run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"1 NEW TypeScript error"* ]]
}

@test "check mode passes and reports the ratchet when a baseline error is fixed" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update

  # Drop one error from the current output -> nothing new, one fewer than baseline.
  local fixed='printf "%s\n" \
    "src/a.ts(10,5): error TS2339: Property (x) does not exist on type (Y)." \
    "src/c.ts(7,2): error TS2769: No overload matches this call."'
  TYPECHECK_TSC_CMD="$fixed" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new type errors"* ]]
  [[ "$output" == *"1 baseline error"* ]]
  [[ "$output" == *"typecheck:update"* ]]
}

@test "check mode errors when the baseline is missing" {
  # Stub tsc so the test never depends on a real compiler (the BATS CI job has no
  # bun deps installed); TYPECHECK_BASELINE points at a not-yet-created path.
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"baseline missing"* ]]
}

@test "fails closed when tsc cannot run (non-zero exit, no parseable errors)" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update

  # tsc crashing / not found must NOT be treated as a clean pass.
  TYPECHECK_TSC_CMD='echo "bunx: command not found" >&2; exit 127' run bash "$SCRIPT"
  [ "$status" -eq 3 ]
  [[ "$output" == *"failed to run"* ]]
}

@test "rejects unknown arguments" {
  run bash "$SCRIPT" --bogus
  [ "$status" -eq 2 ]
  [[ "$output" == *"Unknown argument"* ]]
}

# --- swap-guard (issue #3196, item 1) ---------------------------------------

@test "update writes per-signature swap-fp column fingerprints" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]

  # A swap-fp comment line is recorded for each signature, carrying its columns.
  grep -q '^# swap-fp: 5 :: src/a.ts: error TS2339:' "$TYPECHECK_BASELINE"
  grep -q '^# swap-fp: 1 :: src/b.ts: error TS2345:' "$TYPECHECK_BASELINE"
}

@test "swap-fp comment lines do not corrupt the baseline signature count" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update

  # The success line reports the real signature count (3), not the doubled count
  # that a naive whole-file `grep -c ': error TS'` (which also hits swap-fp) gives.
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"3 known error(s) in baseline"* ]]
}

@test "swap ratchet grow-check ignores swap-fp lines" {
  # Regression guard: prev_count must count only signatures. If swap-fp lines were
  # counted, current(3) vs inflated prev would misfire the grow-check.
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]
  [[ "$output" != *"refusing to grow"* ]]
}

@test "swap-guard warns (non-fatal) when a signature's column set moves" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update

  # Same normalized signature for src/a.ts, but the COLUMN moved 5 -> 88 while the
  # count stayed at 1: a count-neutral swap the fatal gate cannot see.
  local swap='printf "%s\n" \
    "src/a.ts(10,88): error TS2339: Property (x) does not exist on type (Y)." \
    "src/b.ts(3,1): error TS2345: Argument of type (string) is not assignable to parameter of type (number)." \
    "src/c.ts(7,2): error TS2769: No overload matches this call." \
    "Found 3 errors in 3 files."'
  TYPECHECK_TSC_CMD="$swap" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"swap-guard"* ]]
  [[ "$output" == *"src/a.ts: error TS2339"* ]]
  [[ "$output" == *"no new type errors"* ]]
}

@test "swap-guard stays silent on a pure line shift (column unchanged)" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update

  # Line moved 10 -> 99 but column is still 5: an ordinary edit, not a swap.
  local shift='printf "%s\n" \
    "src/a.ts(99,5): error TS2339: Property (x) does not exist on type (Y)." \
    "src/b.ts(3,1): error TS2345: Argument of type (string) is not assignable to parameter of type (number)." \
    "src/c.ts(7,2): error TS2769: No overload matches this call." \
    "Found 3 errors in 3 files."'
  TYPECHECK_TSC_CMD="$shift" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" != *"swap-guard"* ]]
}

@test "swap-guard stays silent on a partial fix (count decreased, not a swap)" {
  # Baseline: src/a.ts has the SAME signature twice, at columns 5 and 42.
  local dup='printf "%s\n" \
    "src/a.ts(10,5): error TS2339: Property (x) does not exist on type (Y)." \
    "src/a.ts(50,42): error TS2339: Property (x) does not exist on type (Y)." \
    "Found 2 errors."'
  TYPECHECK_TSC_CMD="$dup" bash "$SCRIPT" --update

  # Fix the column-42 instance: count drops 2 -> 1. The ratchet celebrates this;
  # it is NOT a swap, so the advisory must stay silent.
  local partial='printf "%s\n" \
    "src/a.ts(10,5): error TS2339: Property (x) does not exist on type (Y)." \
    "Found 1 errors."'
  TYPECHECK_TSC_CMD="$partial" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" != *"swap-guard"* ]]
  [[ "$output" == *"1 baseline error(s) no longer occur"* ]]
}

@test "swap-guard no-ops on a legacy baseline without swap-fp lines" {
  TYPECHECK_TSC_CMD="$FIXTURE_TSC" bash "$SCRIPT" --update
  # Simulate a baseline committed before the swap-fp field existed.
  grep -v '^# swap-fp:' "$TYPECHECK_BASELINE" > "$TYPECHECK_BASELINE.tmp"
  mv "$TYPECHECK_BASELINE.tmp" "$TYPECHECK_BASELINE"

  local swap='printf "%s\n" \
    "src/a.ts(10,88): error TS2339: Property (x) does not exist on type (Y)." \
    "src/b.ts(3,1): error TS2345: Argument of type (string) is not assignable to parameter of type (number)." \
    "src/c.ts(7,2): error TS2769: No overload matches this call." \
    "Found 3 errors in 3 files."'
  TYPECHECK_TSC_CMD="$swap" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" != *"swap-guard"* ]]
  [[ "$output" == *"no new type errors"* ]]
}

# --- Union member order canonicalization (issue #4211) -----------------------
#
# `tsc` renders union members in type-instantiation order, which shifts when the
# module graph changes. A reordered union used to read as a NEW error while the
# identical baselined one read as FIXED, turning `main` red with no code change.

@test "check mode PASSES when a baselined union is re-rendered in a different order" {
  orig='printf "%s\n" "src/u.ts(1,1): error TS2339: Property (s) does not exist on type { severity: \"critical\" | \"high\" | \"medium\" | \"low\"; }."'
  TYPECHECK_TSC_CMD="$orig" bash "$SCRIPT" --update

  # Same error, same members, different render order -- must not be "new".
  reordered='printf "%s\n" "src/u.ts(1,1): error TS2339: Property (s) does not exist on type { severity: \"high\" | \"medium\" | \"critical\" | \"low\"; }."'
  TYPECHECK_TSC_CMD="$reordered" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new type errors"* ]]
  # It must not be reported as fixed either -- that would mean the two signatures
  # still differ and merely cancelled out in the counts.
  [[ "$output" != *"no longer occur"* ]]
}

@test "canonicalization is order-insensitive, NOT laxer: different union members still fail" {
  orig='printf "%s\n" "src/u.ts(1,1): error TS2339: Property (s) does not exist on type { severity: \"critical\" | \"high\" | \"medium\" | \"low\"; }."'
  TYPECHECK_TSC_CMD="$orig" bash "$SCRIPT" --update

  # One member genuinely changed ("low" -> "trivial"): a different type, so a
  # different error, so the gate must still fail closed.
  changed='printf "%s\n" "src/u.ts(1,1): error TS2339: Property (s) does not exist on type { severity: \"critical\" | \"high\" | \"medium\" | \"trivial\"; }."'
  TYPECHECK_TSC_CMD="$changed" run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"1 NEW TypeScript error"* ]]
}

@test "a genuinely new error is still caught alongside a reordered union" {
  orig='printf "%s\n" "src/u.ts(1,1): error TS2339: Property (s) does not exist on type { severity: \"critical\" | \"high\"; }."'
  TYPECHECK_TSC_CMD="$orig" bash "$SCRIPT" --update

  # The union reorders AND an unrelated error appears; only the latter is new.
  both='printf "%s\n" \
    "src/u.ts(1,1): error TS2339: Property (s) does not exist on type { severity: \"high\" | \"critical\"; }." \
    "src/new.ts(2,2): error TS2551: Property (q) does not exist."'
  TYPECHECK_TSC_CMD="$both" run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"1 NEW TypeScript error"* ]]
  [[ "$output" == *"src/new.ts"* ]]
  [[ "$output" != *"src/u.ts"* ]]
}

@test "a legacy baseline with unsorted unions still matches after the change" {
  # Simulate a baseline committed BEFORE canonicalization existed: written by
  # hand with members in non-sorted order, exactly as the real committed
  # baseline holds them.
  cat > "$TYPECHECK_BASELINE" <<EOF
# AutoMobile typecheck baseline (issue #3001) -- see scripts/typecheck-baseline.sh
# generated-with: tsgo 6.0.3
src/legacy.ts: error TS2339: Property (s) does not exist on type { k: "zebra" | "apple" | "mango"; }.
EOF

  same='printf "%s\n" "src/legacy.ts(9,9): error TS2339: Property (s) does not exist on type { k: \"zebra\" | \"apple\" | \"mango\"; }."'
  TYPECHECK_TSC_VERSION="6.0.3" TYPECHECK_TSC_CMD="$same" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new type errors"* ]]
  [[ "$output" != *"no longer occur"* ]]
}

@test "adjacent unions separated by a semicolon are sorted independently" {
  orig='printf "%s\n" "src/two.ts(1,1): error TS2339: Bad type { a: \"y\" | \"x\"; b: string | null; }."'
  TYPECHECK_TSC_CMD="$orig" bash "$SCRIPT" --update

  # Each run canonicalizes on its own; members must not migrate across the ";".
  grep -q 'a: "x" | "y"; b: null | string;' "$TYPECHECK_BASELINE"
}

@test "a union with complex members is left untouched rather than mis-parsed" {
  orig='printf "%s\n" "src/c.ts(1,1): error TS2345: Type { a: number } | null is not assignable."'
  TYPECHECK_TSC_CMD="$orig" bash "$SCRIPT" --update

  # The object-literal member is not a bare token, so the conservative matcher
  # leaves the run alone -- preserving today'"'"'s behavior instead of corrupting it.
  grep -q 'Type { a: number } | null is not assignable' "$TYPECHECK_BASELINE"

  TYPECHECK_TSC_CMD="$orig" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "a string-literal union member containing the separator is not split inside its quotes" {
  # The type `"a | b" | "c"` has a member whose VALUE contains " | ". A naive
  # text split cuts inside the quotes and yields a different result on each
  # pass, so `--update` would write a baseline that check mode instantly
  # rejected as new. Canonicalization must be idempotent here.
  q='printf "%s\n" "src/q.ts(1,1): error TS2322: Type is \"a | b\" | \"c\"."'
  TYPECHECK_TSC_CMD="$q" bash "$SCRIPT" --update

  # Members stay intact and sort as two members, not three.
  grep -q 'Type is "a | b" | "c"' "$TYPECHECK_BASELINE"

  # The freshly written baseline must validate against the very same output.
  TYPECHECK_TSC_CMD="$q" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new type errors"* ]]
  [[ "$output" != *"no longer occur"* ]]
}

@test "update then check is idempotent for every union shape in one line" {
  mixed='printf "%s\n" "src/m.ts(1,1): error TS2322: Bad { a: \"z\" | \"a | b\" | \"c\"; b: string | null; c: { x: 1 } | undefined; }."'
  TYPECHECK_TSC_CMD="$mixed" bash "$SCRIPT" --update
  cp "$TYPECHECK_BASELINE" "$TEST_DIR/first.txt"

  # Re-running update must reproduce the file byte-for-byte.
  TYPECHECK_TSC_CMD="$mixed" bash "$SCRIPT" --update
  diff -q "$TEST_DIR/first.txt" "$TYPECHECK_BASELINE"

  TYPECHECK_TSC_CMD="$mixed" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new type errors"* ]]
}

# --- Escaped quotes inside string-literal members (issue #4257) --------------
#
# The tokenizer keyed on `"[^"]*"`, which cannot represent a literal whose VALUE
# contains an escaped quote. `"z" | "a\" | b" | "c"` tokenized as `"z"`, `"a\"`
# and a bare `b`, so `--update` wrote the corrupted signature
# `"a\" | "z" | b" | "c"`. It is self-consistent (check mode against the same
# render passed) but NOT order-insensitive, so the same baselined error rendered
# in a different order read as NEW -- the exact failure issue #4224 exists to
# prevent.

@test "a member whose value contains an escaped quote is not split at that quote" {
  esc='printf "%s\n" "src/e.ts(1,1): error TS2322: Type is \"z\" | \"a\\\" | b\" | \"c\"."'
  TYPECHECK_TSC_CMD="$esc" bash "$SCRIPT" --update

  # Three members, byte-sorted; the escaped quote and the separator inside the
  # literal both stay within their member.
  grep -qF 'Type is "a\" | b" | "c" | "z".' "$TYPECHECK_BASELINE"
  # The pre-fix corruption must not reappear.
  run grep -cF 'Type is "a\" | "z" | b" | "c".' "$TYPECHECK_BASELINE"
  [ "$output" -eq 0 ]

  # Round trip: the freshly written baseline validates against the same output.
  TYPECHECK_TSC_CMD="$esc" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new type errors"* ]]
  [[ "$output" != *"no longer occur"* ]]
}

@test "a union containing an escaped quote is order-insensitive" {
  esc='printf "%s\n" "src/e.ts(1,1): error TS2322: Type is \"z\" | \"a\\\" | b\" | \"c\"."'
  TYPECHECK_TSC_CMD="$esc" bash "$SCRIPT" --update

  # Same three members, different render order -- must not read as new.
  reordered='printf "%s\n" "src/e.ts(1,1): error TS2322: Type is \"a\\\" | b\" | \"c\" | \"z\"."'
  TYPECHECK_TSC_CMD="$reordered" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new type errors"* ]]
  [[ "$output" != *"no longer occur"* ]]
}

@test "escaped backslashes and escaped quotes tokenize together" {
  # `"b\\"` ends in an escaped BACKSLASH (value `b\`) -- the closing quote is
  # real -- while `"a\" | x"` embeds an escaped QUOTE and the separator. Getting
  # only one of the two escapes right still mis-tokenizes this run.
  esc='printf "%s\n" "src/bs.ts(1,1): error TS2322: Type is \"b\\\\\" | \"a\\\" | x\" | \"c\"."'
  TYPECHECK_TSC_CMD="$esc" bash "$SCRIPT" --update

  grep -qF 'Type is "a\" | x" | "b\\" | "c".' "$TYPECHECK_BASELINE"

  TYPECHECK_TSC_CMD="$esc" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new type errors"* ]]
  [[ "$output" != *"no longer occur"* ]]
}

@test "an escaped-quote union does not absorb a genuinely different error" {
  esc='printf "%s\n" "src/e.ts(1,1): error TS2322: Type is \"z\" | \"a\\\" | b\" | \"c\"."'
  TYPECHECK_TSC_CMD="$esc" bash "$SCRIPT" --update

  # The baselined union reorders (benign) and a DISTINCT error appears whose
  # escaped-quote member has a different value. Only the latter is new, and the
  # baselined signature must not swallow it.
  both='printf "%s\n" \
    "src/e.ts(1,1): error TS2322: Type is \"c\" | \"z\" | \"a\\\" | b\"." \
    "src/e.ts(4,4): error TS2322: Type is \"z\" | \"a\\\" | q\" | \"c\"."'
  TYPECHECK_TSC_CMD="$both" run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"1 NEW TypeScript error"* ]]
  [[ "$output" == *'| q"'* ]]
}

@test "a template-literal member leaves its run untouched instead of mis-parsing" {
  # Template literal types can contain both quotes and pipes and are not part of
  # the token grammar, so the conservative fallback must leave the run alone
  # rather than reorder across it.
  tl='printf "%s\n" "src/t.ts(1,1): error TS2322: Type is \"z\" | \`p|q\` | \"a\"."'
  TYPECHECK_TSC_CMD="$tl" bash "$SCRIPT" --update

  grep -qF 'Type is "z" | `p|q` | "a".' "$TYPECHECK_BASELINE"

  TYPECHECK_TSC_CMD="$tl" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new type errors"* ]]
}
