#!/usr/bin/env bats
# Golden CLI contract for the table-driven boundary scanner (issue #13219).

setup() {
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/scripts/lib" "$repo_dir/src"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-boundary-row.ts" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME/../../scripts/lib/boundaryRows.ts" "$BATS_TEST_DIRNAME/../../scripts/lib/boundaryScanner.ts" \
    "$BATS_TEST_DIRNAME/../../scripts/lib/xcodebuildBoundary.ts" "$BATS_TEST_DIRNAME/../../scripts/lib/executionBoundaryAst.ts" \
    "$repo_dir/scripts/lib/"
  ln -s "$BATS_TEST_DIRNAME/../../node_modules" "$repo_dir/node_modules"
  printf '%s\n' 'spawn("xcodebuild", ["test"]);' > "$repo_dir/src/x.ts"
  printf '%s\n' \
    'diff --git a/src/x.ts b/src/x.ts' '--- /dev/null' '+++ b/src/x.ts' \
    '@@ -0,0 +1 @@' '+spawn("xcodebuild", ["test"]);' > "$repo_dir/diff.patch"
}

teardown() {
  rm -rf "$repo_dir"
}

@test "exits 2 with usage for an unknown row" {
  run bash -c 'cd "$1" && bun scripts/check-boundary-row.ts nope diff.patch' _ "$repo_dir"

  [ "$status" -eq 2 ]
  [[ "$output" == *"usage: check-boundary-row.ts <security|simctl|xcodebuild>"* ]]
}

@test "reports a violation with the row's failure header and exit 1" {
  run bash -c 'cd "$1" && bun scripts/check-boundary-row.ts xcodebuild diff.patch' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"New production xcodebuild execution must go through XcodebuildClient:"* ]]
  [[ "$output" == *'src/x.ts:1:1: spawn("xcodebuild", ["test"])'* ]]
}

@test "passes silently for a row the diff does not violate" {
  run bash -c 'cd "$1" && bun scripts/check-boundary-row.ts security diff.patch' _ "$repo_dir"

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
