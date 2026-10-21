#!/usr/bin/env bats
# bats file_tags=parallel-within-file

setup() {
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/scripts/lib" "$repo_dir/src/utils/ios-cmdline-tools"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-security.sh" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME/../../scripts/lib/vcs-diff.sh" "$repo_dir/scripts/lib/"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-boundary-row.ts" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME/../../scripts/lib/boundary-row.sh" "$BATS_TEST_DIRNAME"/../../scripts/lib/*.ts "$repo_dir/scripts/lib/"
  mkdir -p "$repo_dir/src/utils"
  cp "$BATS_TEST_DIRNAME/../../src/utils/io.ts" "$repo_dir/src/utils/"
  ln -s "$BATS_TEST_DIRNAME/../../node_modules" "$repo_dir/node_modules"
  git -C "$repo_dir" init -q
  # Newer Git runs auto-maintenance detached after commit/fetch; a background
  # writer in .git races teardown's rm -rf ("Directory not empty", #14019).
  git -C "$repo_dir" config maintenance.auto false
  git -C "$repo_dir" config gc.auto 0
  git -C "$repo_dir" config user.email test@example.com
  git -C "$repo_dir" config user.name test
  # `git commit` may spawn a detached `git maintenance`/`gc --auto` that keeps
  # writing under .git after the test ends, racing teardown's rm -rf (#14019).
  git -C "$repo_dir" config gc.auto 0
  git -C "$repo_dir" config gc.autoDetach false
  git -C "$repo_dir" config maintenance.auto false
  touch "$repo_dir/src/existing.ts"
  git -C "$repo_dir" add .
  git -C "$repo_dir" commit -qm baseline
  git -C "$repo_dir" commit --allow-empty -qm head
}

teardown() {
  # Bounded retry: a straggling child can still be flushing into .git.
  local attempt
  for attempt in 1 2 3 4 5; do
    rm -rf "$repo_dir" 2>/dev/null && return 0
    sleep 0.2
  done
  rm -rf "$repo_dir"
}

@test "fixture repo disables detached background git maintenance" {
  [ "$(git -C "$repo_dir" config --get maintenance.auto)" = "false" ]
  [ "$(git -C "$repo_dir" config --get gc.auto)" = "0" ]
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
