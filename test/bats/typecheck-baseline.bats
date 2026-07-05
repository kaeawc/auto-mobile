#!/usr/bin/env bats
#
# Tests for scripts/typecheck-baseline.sh -- the scoped `tsc --noEmit` gate
# (issue #3001). The gate snapshots the existing ~550 type errors into a
# committed baseline and fails only on NEW errors, so the core logic under test
# is the multiset diff between fresh tsc output and the baseline.
#
# tsc is stubbed via TYPECHECK_TSC_CMD so the tests are fast and deterministic --
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
  run wc -l < "$TYPECHECK_BASELINE"
  [ "${output// /}" -eq 3 ]

  # (line,col) is stripped so line shifts do not churn the baseline.
  run grep -c '(10,5)' "$TYPECHECK_BASELINE"
  [ "$output" -eq 0 ]
  grep -q '^src/a.ts: error TS2339:' "$TYPECHECK_BASELINE"
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
  run bash "$SCRIPT"
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
