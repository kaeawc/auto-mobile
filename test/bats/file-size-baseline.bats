#!/usr/bin/env bats
# Tests for scripts/file-size-baseline.sh. A temporary repo tree, cap and baseline
# keep these fast and leave the committed baseline untouched.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/file-size-baseline.sh"
  TEST_DIR="$(mktemp -d)"
  mkdir -p "$TEST_DIR/src/nested"
  export FILE_SIZE_REPO="$TEST_DIR"
  export FILE_SIZE_BASELINE="$TEST_DIR/baseline.txt"
  export FILE_SIZE_MAX=5
  lines 8 > "$TEST_DIR/src/big.ts"
  lines 3 > "$TEST_DIR/src/small.ts"
}

teardown() {
  rm -rf "$TEST_DIR"
}

# lines N: N non-blank lines.
lines() {
  local i
  for ((i = 1; i <= $1; i++)); do echo "const v$i = $i;"; done
}

@test "update records only files over the cap and check passes" {
  run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]
  grep -q "^8"$'\t'"src/big.ts$" "$FILE_SIZE_BASELINE"
  ! grep -q 'small.ts' "$FILE_SIZE_BASELINE"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no growth (1 file(s) over 5 lines"* ]]
}

@test "blank lines do not count" {
  { lines 8; printf '\n\n\n\n'; } > "$TEST_DIR/src/big.ts"
  bash "$SCRIPT" --update
  grep -q "^8"$'\t' "$FILE_SIZE_BASELINE"
}

@test "check fails when a baselined file grows" {
  bash "$SCRIPT" --update
  lines 9 > "$TEST_DIR/src/big.ts"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"1 over baseline in src/big.ts"* ]]
}

@test "check passes when a baselined file shrinks, and update lowers the stored size" {
  bash "$SCRIPT" --update
  lines 6 > "$TEST_DIR/src/big.ts"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]
  grep -q "^6"$'\t' "$FILE_SIZE_BASELINE"
}

@test "a file that falls under the cap leaves the baseline" {
  bash "$SCRIPT" --update
  lines 4 > "$TEST_DIR/src/big.ts"
  bash "$SCRIPT" --update
  ! grep -q 'big.ts' "$FILE_SIZE_BASELINE"
}

@test "check fails for a new or crossing file over the cap, including nested ones" {
  bash "$SCRIPT" --update
  lines 7 > "$TEST_DIR/src/nested/new.ts"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"2 over cap in src/nested/new.ts"* ]]
  rm "$TEST_DIR/src/nested/new.ts"
  lines 6 > "$TEST_DIR/src/small.ts"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/small.ts"* ]]
}

@test "update refuses growth without --allow-grow" {
  bash "$SCRIPT" --update
  lines 9 > "$TEST_DIR/src/big.ts"
  run bash "$SCRIPT" --update
  [ "$status" -eq 1 ]
  [[ "$output" == *"refusing to grow"* ]]
  run bash "$SCRIPT" --update --allow-grow
  [ "$status" -eq 0 ]
  grep -q "^9"$'\t' "$FILE_SIZE_BASELINE"
}

@test "check fails with a hint when the baseline is missing" {
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"baseline missing"* ]]
}

@test "arguments are validated" {
  run bash "$SCRIPT" --allow-grow
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --bogus
  [ "$status" -eq 2 ]
}
