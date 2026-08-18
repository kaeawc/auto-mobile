#!/usr/bin/env bats

# check-lfs-pointers.sh: files routed through LFS by .gitattributes must be
# committed as pointer blobs, never as full content (the jj/no-clean-filter
# hazard). The fixture repos below never install git-lfs; pointers are written
# literally, exactly as a filterless commit path would (or would fail to).

pointer_content() {
  printf 'version https://git-lfs.github.com/spec/v1\n'
  printf 'oid sha256:%s\n' "$1"
  printf 'size 12345\n'
}

setup() {
  # Hermetic git config: the developer machine may have git-lfs filters
  # installed globally, which would clean fixture blobs into real pointers
  # and make violations impossible to construct.
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/scripts/lib"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-lfs-pointers.sh" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME/../../scripts/lib/vcs-diff.sh" "$repo_dir/scripts/lib/"
  git -C "$repo_dir" init -q
  git -C "$repo_dir" config user.email test@example.com
  git -C "$repo_dir" config user.name test
  printf '%s\n' '*.png filter=lfs diff=lfs merge=lfs -text' > "$repo_dir/.gitattributes"
  printf '%s\n' 'exempt/*.png -filter -diff -merge -text' >> "$repo_dir/.gitattributes"
}

teardown() {
  rm -rf "$repo_dir"
}

commit_all() {
  git -C "$repo_dir" add -A
  git -C "$repo_dir" commit -qm "$1"
}

@test "passes when every LFS-routed file is a pointer" {
  pointer_content aaaa1111 > "$repo_dir/demo.png"
  commit_all pointers

  run bash -c 'cd "$1" && bash scripts/check-lfs-pointers.sh' _ "$repo_dir"

  [ "$status" -eq 0 ]
  [[ "$output" == *"are pointers"* ]]
}

@test "rejects a large full blob where a pointer is required" {
  head -c 2048 /dev/zero > "$repo_dir/demo.png"
  commit_all blob

  run bash -c 'cd "$1" && bash scripts/check-lfs-pointers.sh' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"demo.png (2048-byte blob"* ]]
}

@test "rejects a small non-pointer blob where a pointer is required" {
  printf 'tiny but real image bytes' > "$repo_dir/demo.png"
  commit_all small-blob

  run bash -c 'cd "$1" && bash scripts/check-lfs-pointers.sh' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"demo.png (small blob but not an LFS pointer)"* ]]
}

@test "ignores files whose LFS filter is unset by a later pattern" {
  mkdir -p "$repo_dir/exempt"
  head -c 2048 /dev/zero > "$repo_dir/exempt/icon.png"
  commit_all exempt

  run bash -c 'cd "$1" && bash scripts/check-lfs-pointers.sh' _ "$repo_dir"

  [ "$status" -eq 0 ]
}

@test "ignores files not matched by any LFS pattern" {
  head -c 2048 /dev/zero > "$repo_dir/data.bin"
  commit_all unmatched

  run bash -c 'cd "$1" && bash scripts/check-lfs-pointers.sh' _ "$repo_dir"

  [ "$status" -eq 0 ]
}

@test "checks the requested rev, not the working tree" {
  pointer_content bbbb2222 > "$repo_dir/demo.png"
  commit_all pointer
  head -c 2048 /dev/zero > "$repo_dir/demo.png"
  commit_all blob

  run bash -c 'cd "$1" && bash scripts/check-lfs-pointers.sh HEAD^' _ "$repo_dir"
  [ "$status" -eq 0 ]

  run bash -c 'cd "$1" && bash scripts/check-lfs-pointers.sh HEAD' _ "$repo_dir"
  [ "$status" -eq 1 ]
}

@test "handles paths with spaces" {
  mkdir -p "$repo_dir/docs img"
  head -c 2048 /dev/zero > "$repo_dir/docs img/demo shot.png"
  commit_all spaces

  run bash -c 'cd "$1" && bash scripts/check-lfs-pointers.sh' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"docs img/demo shot.png"* ]]
}
