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

@test "double-cast ratchet counts as unknown as, including parenthesized and multiline forms" {
  printf 'const a = (value as unknown) as T;\nconst b = other as unknown as\n  U;\nconst c = x as unknown;\nconst s = "as unknown as T"; // y as unknown as T\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]
  [[ "$output" == *"(2 gated double cast(s))"* ]]
  grep -q "^2[[:space:]].*a.test.ts" "${TEST_AS_ANY_BASELINE%.txt}.unknown.txt"
}

@test "double-cast check fails when a file grows or a new file appears" {
  bash "$SCRIPT" --update
  printf 'const a = value as unknown as T;\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"1 new in"*"a.test.ts"* ]]
  bash "$SCRIPT" --update --allow-grow
  printf 'const a = value as unknown as T;\nconst b = value as unknown as T;\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  printf 'const c = v as unknown as T;\n' > "$TEST_AS_ANY_ROOT/new.test.ts"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"new.test.ts"* ]]
}

@test "double-cast update shrinks and refuses growth without --allow-grow" {
  printf 'const a = v as unknown as T; const b = v as unknown as T;\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  bash "$SCRIPT" --update --allow-grow
  printf 'const a = v as unknown as T;\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]
  grep -q "^1[[:space:]].*a.test.ts" "${TEST_AS_ANY_BASELINE%.txt}.unknown.txt"
  printf 'const a = v as unknown as T; const b = v as unknown as T;\n' > "$TEST_AS_ANY_ROOT/a.test.ts"
  run bash "$SCRIPT" --update
  [ "$status" -eq 1 ]
  [[ "$output" == *"refusing to grow"* ]]
}

@test "a missing test root fails in check and update mode and leaves the baselines intact" {
  bash "$SCRIPT" --update
  before_any="$(cat "$TEST_AS_ANY_BASELINE")"
  before_unknown="$(cat "${TEST_AS_ANY_BASELINE%.txt}.unknown.txt")"
  export TEST_AS_ANY_ROOT="$TEST_DIR/does-not-exist"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"could not count"* ]]
  run bash "$SCRIPT" --update
  [ "$status" -ne 0 ]
  [ "$(cat "$TEST_AS_ANY_BASELINE")" = "$before_any" ]
  [ "$(cat "${TEST_AS_ANY_BASELINE%.txt}.unknown.txt")" = "$before_unknown" ]
}

@test "an unreadable test file fails in check and update mode and leaves the baselines intact" {
  if [ "$(id -u)" -eq 0 ]; then
    skip "root can read any file"
  fi
  bash "$SCRIPT" --update
  before_any="$(cat "$TEST_AS_ANY_BASELINE")"
  chmod 000 "$TEST_AS_ANY_ROOT/a.test.ts"
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  run bash "$SCRIPT" --update
  [ "$status" -ne 0 ]
  chmod 644 "$TEST_AS_ANY_ROOT/a.test.ts"
  [ "$(cat "$TEST_AS_ANY_BASELINE")" = "$before_any" ]
}
