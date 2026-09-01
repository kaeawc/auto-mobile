#!/usr/bin/env bats

setup_file() {
  repo_dir="$(mktemp -d)"
  state_file="${TMPDIR:-/tmp}/auto-mobile-simctl-bats-fixture"
  mkdir -p "$repo_dir/scripts/lib" "$repo_dir/src"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-simctl.sh" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME/../../scripts/lib/vcs-diff.sh" "$repo_dir/scripts/lib/"
  git -C "$repo_dir" init -q
  git -C "$repo_dir" config user.email test@example.com
  git -C "$repo_dir" config user.name test
  touch "$repo_dir/src/existing.ts"
  git -C "$repo_dir" add .
  git -C "$repo_dir" commit -qm baseline
  git -C "$repo_dir" commit --allow-empty -qm head
  printf '%s\n' "$repo_dir" > "$state_file"
}

setup() {
  state_file="${TMPDIR:-/tmp}/auto-mobile-simctl-bats-fixture"
  repo_dir="$(<"$state_file")"
  git -C "$repo_dir" checkout -q --detach HEAD
  git -C "$repo_dir" checkout -q -B bats-main HEAD
  git -C "$repo_dir" reset --hard -q HEAD
  git -C "$repo_dir" clean -fdq
  rm -rf "${remote_dir:-}" "${shallow_dir:-}"
  unset remote_dir shallow_dir
}

teardown_file() {
  state_file="${TMPDIR:-/tmp}/auto-mobile-simctl-bats-fixture"
  repo_dir="$(<"$state_file")"
  rm -rf "$repo_dir"
  rm -f "$state_file"
}

@test "rejects a new argv-form xcrun execution" {
  printf '%s\n' 'execFile("xcrun", ["simctl", "list", "devices"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a synchronous argv-form xcrun execution" {
  printf '%s\n' 'execFileSync("xcrun", ["simctl", "list", "devices"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a template-literal argv-form xcrun execution" {
  printf '%s\n' 'execFileSync(`xcrun`, ["simctl", "list", "devices"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a single-quoted argv-form xcrun execution" {
  printf '%s\n' "execFileSync('xcrun', [\"simctl\", \"list\", \"devices\"]);" > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a synchronous shell-form xcrun simctl execution" {
  printf '%s\n' 'execSync("xcrun simctl list devices");' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a template-literal shell-form xcrun simctl execution" {
  printf '%s\n' 'execSync(`xcrun simctl list devices`);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a single-quoted shell-form xcrun simctl execution" {
  printf '%s\n' "execSync('xcrun simctl list devices');" > "$repo_dir/src/bypass.ts"
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

@test "rejects a variable argv-form xcrun simctl execution" {
  printf '%s\n' 'const args = ["simctl", "list", "devices"];' 'execFile("xcrun", args);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "fails closed when the base ref is absent" {
  # Neutralize the CI environment: on a GitHub Actions runner GITHUB_ACTIONS
  # and GITHUB_BASE_REF are set, which would send the script down its
  # fetch-the-PR-base branch (and die at `git fetch` in this remote-less temp
  # repo, exit 128) instead of the fail-closed path this test exercises.
  run env -u GITHUB_ACTIONS -u GITHUB_BASE_REF \
    bash -c 'cd "$1" && bash scripts/check-no-new-direct-simctl.sh origin/main' _ "$repo_dir"

  [ "$status" -eq 2 ]
  [[ "$output" == *"base ref origin/main does not exist"* ]]
}

@test "fetches the GitHub Actions PR base from a depth-one checkout" {
  remote_dir="$(mktemp -d)"
  shallow_dir="$(mktemp -d)"
  git -C "$repo_dir" branch -M main
  git -C "$repo_dir" remote add origin "$remote_dir"
  git -C "$remote_dir" init --bare -q
  git -C "$repo_dir" push -q origin main
  git -C "$repo_dir" checkout -qb feature
  printf '%s\n' 'export const noop = true;' > "$repo_dir/src/change.ts"
  git -C "$repo_dir" add src/change.ts
  git -C "$repo_dir" commit -qm feature
  git -C "$repo_dir" push -q origin feature
  rmdir "$shallow_dir"
  git clone --depth 1 --branch feature -q "file://$remote_dir" "$shallow_dir"

  run git -C "$shallow_dir" rev-parse --verify --quiet 'HEAD^1^{commit}'
  [ "$status" -ne 0 ]
  run git -C "$shallow_dir" rev-parse --verify --quiet 'origin/main^{commit}'
  [ "$status" -ne 0 ]

  run bash -c 'cd "$1" && GITHUB_ACTIONS=true GITHUB_BASE_REF=main bash scripts/check-no-new-direct-simctl.sh' _ "$shallow_dir"

  [ "$status" -eq 0 ]
  git -C "$shallow_dir" rev-parse --verify --quiet 'origin/main^{commit}'
}
