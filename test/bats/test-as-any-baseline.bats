#!/usr/bin/env bats
# Tests for scripts/test-as-any-baseline.sh. A temporary test tree and baseline
# keep these fast and leave the committed baseline untouched.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/test-as-any-baseline.sh"
  TEST_DIR="$(mktemp -d)"
  mkdir -p "$TEST_DIR/test"
  export TEST_AS_ANY_BASELINE="$TEST_DIR/baseline.txt"
  export TEST_AS_ANY_ROOT="$TEST_DIR/test"
  printf 'const a = value as any;\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "check passes at or under the per-file baseline and skips comments and strings" {
  bash "$SCRIPT" --update
  printf 'const a = value as any; // value as any\nconst text = "as any";\n/* value as any */\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new assertions (1 gated assertion(s)"* ]]
  printf 'const text = "as any";\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "check fails when an existing file grows or a new file appears" {
  bash "$SCRIPT" --update
  printf 'const a = value as any; const b = other as any;\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"1 new in"*"a.test.ts"* ]]
  printf 'const a = value as any;\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  printf 'const c = value as any;\n' > "$TEST_AS_ANY_ROOT/new.test.ts"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"new.test.ts"* ]]
}

@test "update shrinks the baseline" {
  bash "$SCRIPT" --update
  printf 'const a = value;\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]
  ! grep -q 'a.test.ts' "$TEST_AS_ANY_BASELINE"
}

@test "update refuses growth without --allow-grow" {
  bash "$SCRIPT" --update
  printf 'const a = value as any; const b = other as any;\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  run bash "$SCRIPT" --update
  [ "$status" -eq 1 ]
  [[ "$output" == *"refusing to grow"* ]]
  run bash "$SCRIPT" --update --allow-grow
  [ "$status" -eq 0 ]
  grep -q "^2[[:space:]]" "$TEST_AS_ANY_BASELINE"
}

@test "a symlinked test root keys files by their real path" {
  bash "$SCRIPT" --update
  ln -s "$TEST_DIR/test" "$TEST_DIR/linked-test"
  TEST_AS_ANY_ROOT="$TEST_DIR/linked-test" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new assertions (1 gated assertion(s)"* ]]
}
