#!/usr/bin/env bats

setup() {
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/scripts" "$repo_dir/src"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-simctl.sh" "$repo_dir/scripts/"
  git -C "$repo_dir" init -q
  git -C "$repo_dir" config user.email test@example.com
  git -C "$repo_dir" config user.name test
  touch "$repo_dir/src/existing.ts"
  git -C "$repo_dir" add .
  git -C "$repo_dir" commit -qm baseline
}

teardown() {
  rm -rf "$repo_dir"
}

@test "rejects a new argv-form xcrun execution" {
  printf '%s\n' 'execFile("xcrun", ["simctl", "list", "devices"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a multiline argv-form xcrun simctl execution" {
  printf '%s\n' 'execFile(' '  "xcrun",' '  [' '    "simctl",' '    "list",' '    "devices",' '  ],' ');' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "fails closed when the base ref is absent" {
  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh origin/main' _ "$repo_dir"

  [ "$status" -eq 2 ]
  [[ "$output" == *"base ref origin/main does not exist"* ]]
}
