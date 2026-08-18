#!/usr/bin/env bats

setup() {
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/scripts/lib" "$repo_dir/src/utils/ios-cmdline-tools"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-security.sh" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME/../../scripts/lib/vcs-diff.sh" "$repo_dir/scripts/lib/"
  git -C "$repo_dir" init -q
  git -C "$repo_dir" config user.email test@example.com
  git -C "$repo_dir" config user.name test
  touch "$repo_dir/src/existing.ts"
  git -C "$repo_dir" add .
  git -C "$repo_dir" commit -qm baseline
  git -C "$repo_dir" commit --allow-empty -qm head
}

teardown() {
  rm -rf "$repo_dir"
}

@test "rejects a new argv-form security execution" {
  printf '%s\n' 'execFile("security", ["find-identity"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-security.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a multiline argv-form security execution" {
  printf '%s\n' 'execFile(' '  "security",' '  ["cms", "-D", "-i", profile],' ');' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-security.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects synchronous and shell-form security execution" {
  printf '%s\n' 'execFileSync(`security`, ["find-identity"]);' 'execSync("security cms -D -i profile");' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-security.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects absolute, commented, and Bun.spawn security execution" {
  printf '%s\n' 'execFile("/usr/bin/security", ["find-identity"]);' 'execFile(/* signing */ "security", ["find-identity"]);' 'Bun.spawn(["security", "find-identity"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-security.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "allows SecurityClient to own the invocation" {
  printf '%s\n' 'execFile("security", ["find-identity"]);' > "$repo_dir/src/utils/ios-cmdline-tools/SecurityClient.ts"
  git -C "$repo_dir" add src/utils/ios-cmdline-tools/SecurityClient.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-security.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 0 ]
}

@test "fails closed when the base ref is absent" {
  run env -u GITHUB_ACTIONS -u GITHUB_BASE_REF \
    bash -c 'cd "$1" && bash scripts/check-no-new-direct-security.sh origin/main' _ "$repo_dir"

  [ "$status" -eq 2 ]
  [[ "$output" == *"base ref origin/main does not exist"* ]]
}
