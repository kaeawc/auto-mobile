#!/usr/bin/env bats
#
# Tests for scripts/typecheck-baseline.sh -- the scoped `tsgo --noEmit` gate
# (issues #3001, #11787). The src project has no baseline (any error fails); the
# test project ratchets compact `<file> <TScode> <count>` rows.
#
# tsgo is stubbed via TYPECHECK_TSC_CMD so the tests are fast and deterministic.
# The test baseline is redirected via TYPECHECK_BASELINE so the committed one is
# never touched.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/typecheck-baseline.sh"
  TEST_DIR="$(mktemp -d)"
  export TYPECHECK_BASELINE="$TEST_DIR/baseline.txt"
  TWO='printf "%s\n" "test/a.test.ts(1,1): error TS2345: x." "test/a.test.ts(9,9): error TS2345: y." "  detail line" "Found 2 errors in 1 file."'
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "src gate passes on clean output" {
  TYPECHECK_TSC_CMD='true' run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no type errors"* ]]
}

@test "src gate fails on any error and lists it" {
  TYPECHECK_TSC_CMD='printf "%s\n" "src/a.ts(10,5): error TS2339: nope." && false' run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/a.ts(10,5): error TS2339"* ]]
}

@test "src gate has no update mode and no baseline file" {
  run bash "$SCRIPT" --update
  [ "$status" -eq 2 ]
  [ ! -e "$REPO_ROOT/scripts/typecheck-baseline.txt" ]
}

@test "types guard fails on a missing type definition file in every mode" {
  local missing='printf "%s\n" "tsconfig.json(1,1): error TS2688: Cannot find type definition file for '"'"'bun'"'"'." && false'
  TYPECHECK_TSC_CMD="$missing" run bash "$SCRIPT"
  [ "$status" -eq 4 ]
  TYPECHECK_TSC_CMD="$missing" run bash "$SCRIPT" --project=test --update --allow-grow
  [ "$status" -eq 4 ]
  [ ! -e "$TYPECHECK_BASELINE" ]
}

@test "types guard fails on an unresolved bun: module" {
  local missing='printf "%s\n" "test/a.test.ts(1,22): error TS2307: Cannot find module '"'"'bun:test'"'"' or its corresponding type declarations." && false'
  TYPECHECK_TSC_CMD="$missing" run bash "$SCRIPT" --project=test
  [ "$status" -eq 4 ]
}

@test "tsconfigs resolve bun types and the test project covers test/**/*.ts" {
  grep -q '"bun"' "$REPO_ROOT/tsconfig.json"
  grep -q '"bun"' "$REPO_ROOT/tsconfig.test.json"
  grep -q 'test/\*\*/\*.ts' "$REPO_ROOT/tsconfig.test.json"
  grep -q '^# generated-with: tsgo' "$REPO_ROOT/scripts/typecheck-test-baseline.txt"
}

@test "--project=test writes compact rows and ratchets on counts" {
  TYPECHECK_TSC_CMD="$TWO" bash "$SCRIPT" --project=test --update
  grep -qx 'test/a.test.ts TS2345 2' "$TYPECHECK_BASELINE"
  ! grep -q 'detail line' "$TYPECHECK_BASELINE"
  TYPECHECK_TSC_CMD="$TWO" run bash "$SCRIPT" --project=test
  [ "$status" -eq 0 ]
  local three="$TWO"' && printf "%s\n" "test/a.test.ts(20,1): error TS2345: z."'
  TYPECHECK_TSC_CMD="$three" run bash "$SCRIPT" --project=test
  [ "$status" -eq 1 ]
  [[ "$output" == *"test/a.test.ts TS2345: 2 -> 3"* ]]
}

@test "a new file/code pair fails" {
  TYPECHECK_TSC_CMD="$TWO" bash "$SCRIPT" --project=test --update
  local other="$TWO"' && printf "%s\n" "test/b.test.ts(1,1): error TS2322: z."'
  TYPECHECK_TSC_CMD="$other" run bash "$SCRIPT" --project=test
  [ "$status" -eq 1 ]
  [[ "$output" == *"test/b.test.ts TS2322: 0 -> 1"* ]]
}

@test "--update refuses to grow without --allow-grow" {
  TYPECHECK_TSC_CMD="$TWO" bash "$SCRIPT" --project=test --update
  local three="$TWO"' && printf "%s\n" "test/a.test.ts(20,1): error TS2345: z."'
  TYPECHECK_TSC_CMD="$three" run bash "$SCRIPT" --project=test --update
  [ "$status" -eq 1 ]
  TYPECHECK_TSC_CMD="$three" run bash "$SCRIPT" --project=test --update --allow-grow
  [ "$status" -eq 0 ]
  grep -qx 'test/a.test.ts TS2345 3' "$TYPECHECK_BASELINE"
}

@test "a shrink passes and suggests ratcheting" {
  TYPECHECK_TSC_CMD="$TWO" bash "$SCRIPT" --project=test --update
  local one='printf "%s\n" "test/a.test.ts(1,1): error TS2345: x."'
  TYPECHECK_TSC_CMD="$one" run bash "$SCRIPT" --project=test
  [ "$status" -eq 0 ]
  [[ "$output" == *"no longer occur"* ]]
}

@test "warns (non-fatal) when tsgo version differs from the baseline" {
  TYPECHECK_TSC_VERSION="7.0.0-old" TYPECHECK_TSC_CMD="$TWO" bash "$SCRIPT" --project=test --update
  TYPECHECK_TSC_VERSION="7.0.0-new" TYPECHECK_TSC_CMD="$TWO" run bash "$SCRIPT" --project=test
  [ "$status" -eq 0 ]
  [[ "$output" == *"version differs"* ]]
}

@test "test gate errors when the baseline is missing" {
  TYPECHECK_TSC_CMD="$TWO" run bash "$SCRIPT" --project=test
  [ "$status" -eq 1 ]
  [[ "$output" == *"baseline missing"* ]]
}

@test "fails closed when tsc cannot run (non-zero exit, no parseable errors)" {
  TYPECHECK_TSC_CMD='echo "boom" && false' run bash "$SCRIPT"
  [ "$status" -eq 3 ]
}

@test "rejects unknown arguments and --allow-grow without --update" {
  run bash "$SCRIPT" --bogus
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --allow-grow
  [ "$status" -eq 2 ]
}
