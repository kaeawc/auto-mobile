#!/usr/bin/env bats
#
# Keep oxlint's autofix output compatible with oxfmt's formatter.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  TEST_DIR="$(mktemp -d)"
  FIXTURE="$TEST_DIR/fixture.ts"
  printf 'if (true) console.log("fixture");\n' >"$FIXTURE"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "oxlint autofix output is oxfmt-clean and idempotent" {
  run bash -c 'cd "$1" && bunx oxlint --fix "$2"' _ "$REPO_ROOT" "$FIXTURE"
  [ "$status" -eq 0 ]

  run bash -c 'cd "$1" && bunx oxfmt --write "$2"' _ "$REPO_ROOT" "$FIXTURE"
  [ "$status" -eq 0 ]

  run bash -c 'cd "$1" && bunx oxfmt --check "$2"' _ "$REPO_ROOT" "$FIXTURE"
  [ "$status" -eq 0 ]

  first_output="$(<"$FIXTURE")"
  run bash -c 'cd "$1" && bunx oxlint --fix "$2" && bunx oxfmt --write "$2"' _ "$REPO_ROOT" "$FIXTURE"
  [ "$status" -eq 0 ]
  [ "$(<"$FIXTURE")" = "$first_output" ]

  run bash -c 'cd "$1" && bunx oxfmt --check "$2"' _ "$REPO_ROOT" "$FIXTURE"
  [ "$status" -eq 0 ]
}

@test "oxfmt runs when oxlint reports an unfixed violation" {
  fixture_with_error="$TEST_DIR/fixture-with-error.ts"
  printf 'if (true) console.log("fixture");\nif (a == b) { console.log(a); }\n' >"$fixture_with_error"

  run env PATH="$REPO_ROOT/node_modules/.bin:$PATH" bash "$REPO_ROOT/scripts/lint.sh" "$fixture_with_error"
  [ "$status" -ne 0 ]
  [[ "$output" == *"skipping baseline and boundary checks"* ]]
  grep -q 'if (true) {' "$fixture_with_error"

  run bash -c 'cd "$1" && bunx oxfmt --check "$2"' _ "$REPO_ROOT" "$fixture_with_error"
  [ "$status" -eq 0 ]
}
