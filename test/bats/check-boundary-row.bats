#!/usr/bin/env bats
# Golden CLI contract for the table-driven boundary scanner (issue #13219).

setup() {
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/scripts/lib" "$repo_dir/src/utils"
  cp "$BATS_TEST_DIRNAME/../../src/utils/io.ts" "$repo_dir/src/utils/"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-boundary-row.ts" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME"/../../scripts/lib/*.ts "$repo_dir/scripts/lib/"
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
  [[ "$output" == *"usage: check-boundary-row.ts <security|simctl|xcodebuild|plutil|ffmpeg|simulator-tcc-sqlite|android-emulator|ios-ctrl-proxy-process|app-bundle-metadata|child-process-import|archive-extraction|daemon-launcher|host-shell>"* ]]
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

@test "tree rows scan src/ without a diff and keep their golden output" {
  mkdir -p "$repo_dir/src/deep"
  printf '%s\n' 'import { spawn } from "node:child_process"; spawn("ffmpeg", []);' > "$repo_dir/src/deep/f.ts"

  run bash -c 'cd "$1" && bun scripts/check-boundary-row.ts ffmpeg' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"error: FFmpeg execution must use src/utils/media/FfmpegClient.ts:"* ]]
  [[ "$output" == *'deep/f.ts:1:'*'spawn("ffmpeg", [])'* ]]
}

@test "tree rows pass on a clean tree with their success message" {
  run bash -c 'cd "$1" && bun scripts/check-boundary-row.ts plutil && bun scripts/check-boundary-row.ts android-emulator' _ "$repo_dir"

  [ "$status" -eq 0 ]
  [[ "$output" == *"android-emulator-boundary: no direct production emulator invocations."* ]]
}

@test "diff rows still require a diff file" {
  run bash -c 'cd "$1" && bun scripts/check-boundary-row.ts security' _ "$repo_dir"

  [ "$status" -eq 2 ]
}

@test "child-process-import reports bare positions and exits 1" {
  printf '%s\n' 'import { execFile } from "child_process";' > "$repo_dir/src/utils/bad.ts"

  run bash -c 'cd "$1" && bun scripts/check-boundary-row.ts child-process-import' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"error: child_process imports are restricted to the reviewed allowlist:"* ]]
  [[ "$output" == *"src/utils/bad.ts:1:1"* ]]
}
