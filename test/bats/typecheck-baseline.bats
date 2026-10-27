#!/usr/bin/env bats
#
# Tests for scripts/typecheck-baseline.sh -- the scoped `tsgo --noEmit` gate
# (issues #3001, #11787). Neither project has a baseline: any error fails.
#
# tsgo is stubbed via TYPECHECK_TSC_CMD so the tests are fast and deterministic.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/typecheck-baseline.sh"
  TWO='printf "%s\n" "test/a.test.ts(1,1): error TS2345: x." "test/a.test.ts(9,9): error TS2345: y." "  detail line" "Found 2 errors in 1 file." && false'
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

@test "test gate passes on clean output" {
  TYPECHECK_TSC_CMD='true' run bash "$SCRIPT" --project=test
  [ "$status" -eq 0 ]
  [[ "$output" == *"no type errors"* ]]
}

@test "test gate fails on any single error and lists it" {
  TYPECHECK_TSC_CMD="$TWO" run bash "$SCRIPT" --project=test
  [ "$status" -eq 1 ]
  [[ "$output" == *"2 TypeScript error(s)"* ]]
  [[ "$output" == *"test/a.test.ts(1,1): error TS2345"* ]]
}

@test "there is no update mode and no baseline file for either project" {
  run bash "$SCRIPT" --update
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --project=test --update
  [ "$status" -eq 2 ]
  [ ! -e "$REPO_ROOT/scripts/typecheck-baseline.txt" ]
  [ ! -e "$REPO_ROOT/scripts/typecheck-test-baseline.txt" ]
}

@test "types guard fails on a missing type definition file for both projects" {
  local missing='printf "%s\n" "tsconfig.json(1,1): error TS2688: Cannot find type definition file for '"'"'bun'"'"'." && false'
  TYPECHECK_TSC_CMD="$missing" run bash "$SCRIPT"
  [ "$status" -eq 4 ]
  TYPECHECK_TSC_CMD="$missing" run bash "$SCRIPT" --project=test
  [ "$status" -eq 4 ]
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
}

@test "fails closed when tsc cannot run (non-zero exit, no parseable errors)" {
  TYPECHECK_TSC_CMD='echo "boom" && false' run bash "$SCRIPT"
  [ "$status" -eq 3 ]
}

@test "rejects unknown arguments" {
  run bash "$SCRIPT" --bogus
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --allow-grow
  [ "$status" -eq 2 ]
}

@test "the test project is split into shards that together cover every test file (#15580)" {
  # The rest shard excludes exactly the directories the other two shards include, so a new test
  # directory falls into it by construction.
  grep -q 'tsconfig.test-daemon.json' "$REPO_ROOT/scripts/typecheck-baseline.sh"
  grep -q 'tsconfig.test-features.json' "$REPO_ROOT/scripts/typecheck-baseline.sh"
  grep -q 'tsconfig.test-rest.json' "$REPO_ROOT/scripts/typecheck-baseline.sh"
  for dir in 'test/daemon/\*\*' 'test/server/\*\*' 'test/features/\*\*'; do
    grep -q "$dir" "$REPO_ROOT/tsconfig.test-rest.json"
  done
  grep -q 'test/\*\*/\*.ts' "$REPO_ROOT/tsconfig.test-rest.json"
}
