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
