#!/usr/bin/env bats

setup() {
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/scripts" "$repo_dir/src/utils"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-git-metadata.sh" "$repo_dir/scripts/"
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

@test "rejects a new direct argv git execution outside the owner" {
  printf '%s\n' 'spawnSync("git", ["rev-parse", "HEAD"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-git-metadata.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a new shell-form git execution outside the owner" {
  printf '%s\n' 'execSync("git rev-parse HEAD");' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-git-metadata.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "allows GitMetadataClient to own direct git execution" {
  printf '%s\n' 'spawnSync("git", ["rev-parse", "HEAD"]);' > "$repo_dir/src/utils/GitMetadataClient.ts"
  git -C "$repo_dir" add src/utils/GitMetadataClient.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-git-metadata.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 0 ]
}
