#!/usr/bin/env bats
# bats file_tags=parallel-within-file

setup() {
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/scripts/lib" "$repo_dir/test/features/element-resolution"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-element-resolution-ratchet.sh" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-element-resolution-ratchet.ts" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME/../../scripts/lib/vcs-diff.sh" "$repo_dir/scripts/lib/"
  baseline="$repo_dir/test/features/element-resolution/observeContractGaps.json"
  signatures="$repo_dir/test/features/element-resolution/observeContractGapSignatures.json"
  cases="$repo_dir/test/features/element-resolution/observeContractCaseKeys.json"
  printf '%s\n' '{"B1":["a","b"]}' > "$baseline"
  printf '%s\n' '{"a":"old","b":null}' > "$signatures"
  printf '%s\n' '["case-a","case-b"]' > "$cases"
  git -C "$repo_dir" init -q
  git -C "$repo_dir" config user.email test@example.com
  git -C "$repo_dir" config user.name test
  git -C "$repo_dir" add .
  git -C "$repo_dir" commit -qm baseline
}

teardown() {
  rm -rf "$repo_dir"
}

@test "allows shrink against committed baseline" {
  printf '%s\n' '{"B1":["a"]}' > "$baseline"
  run bash "$repo_dir/scripts/check-element-resolution-ratchet.sh" HEAD
  [ "$status" -eq 0 ]
}

@test "rejects replacement of a removed exception with another" {
  printf '%s\n' '{"B1":["a","new"]}' > "$baseline"
  run bash "$repo_dir/scripts/check-element-resolution-ratchet.sh" HEAD
  [ "$status" -ne 0 ]
  [[ "$output" == *"only shrink"* ]]
}

@test "rejects changed signatures for retained exceptions" {
  printf '%s\n' '{"a":"new","b":null}' > "$signatures"
  run bash "$repo_dir/scripts/check-element-resolution-ratchet.sh" HEAD
  [ "$status" -ne 0 ]
  [[ "$output" == *"signatures may only shrink"* ]]
}

@test "rejects removal or replacement of a previously green case key" {
  printf '%s\n' '["case-a","case-c"]' > "$cases"
  run bash "$repo_dir/scripts/check-element-resolution-ratchet.sh" HEAD
  [ "$status" -ne 0 ]
  [[ "$output" == *"case keys may only grow"* ]]
  [[ "$output" == *"case-b"* ]]
}

@test "fails closed without the requested base" {
  run bash "$repo_dir/scripts/check-element-resolution-ratchet.sh" missing-base
  [ "$status" -eq 2 ]
  [[ "$output" == *"missing base"* ]]
}

@test "bootstrap rejects an unreviewed seed even if the baseline file is absent" {
  git -C "$repo_dir" rm -q test/features/element-resolution/observeContractGaps.json
  git -C "$repo_dir" commit -qm remove
  mkdir -p "$(dirname "$baseline")"
  printf '%s\n' '{}' > "$baseline"
  run bash "$repo_dir/scripts/check-element-resolution-ratchet.sh" HEAD
  [ "$status" -ne 0 ]
  [[ "$output" == *"reviewed initial"* ]]
}

@test "GitHub PR target controls the baseline even when origin main exists" {
  git -C "$repo_dir" branch origin/main
  printf '%s\n' '{"B1":["a"]}' > "$baseline"
  git -C "$repo_dir" add .
  git -C "$repo_dir" commit -qm shrink
  git -C "$repo_dir" branch origin/release
  printf '%s\n' '{"B1":["a","b"]}' > "$baseline"
  run env GITHUB_ACTIONS=true GITHUB_BASE_REF=release bash "$repo_dir/scripts/check-element-resolution-ratchet.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"only shrink"* ]]
  run env GITHUB_ACTIONS=true GITHUB_BASE_REF=release bash "$repo_dir/scripts/check-element-resolution-ratchet.sh" origin/main
  [ "$status" -eq 0 ]
}
