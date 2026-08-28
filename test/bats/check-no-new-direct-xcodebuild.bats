#!/usr/bin/env bats

setup() {
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/scripts/lib" "$repo_dir/src/utils/ios-cmdline-tools"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-xcodebuild.sh" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-xcodebuild.ts" "$repo_dir/scripts/"
  cp "$BATS_TEST_DIRNAME/../../scripts/lib/executionBoundaryAst.ts" "$repo_dir/scripts/lib/"
  cp "$BATS_TEST_DIRNAME/../../scripts/lib/vcs-diff.sh" "$repo_dir/scripts/lib/"
  ln -s "$BATS_TEST_DIRNAME/../../node_modules" "$repo_dir/node_modules"
  touch "$repo_dir/src/utils/ios-cmdline-tools/XcodebuildClient.ts"
  git -C "$repo_dir" init -q
  git -C "$repo_dir" config user.email test@example.com
  git -C "$repo_dir" config user.name test
  git -C "$repo_dir" add .
  git -C "$repo_dir" commit -qm baseline
  git -C "$repo_dir" commit --allow-empty -qm head
}

teardown() {
  rm -rf "$repo_dir"
}

@test "rejects a new direct argv-form xcodebuild execution" {
  printf '%s\n' 'spawn("xcodebuild", ["test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a new single-quoted shell-form xcodebuild execution" {
  printf '%s\n' "execSync('xcodebuild -version');" > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a template-literal xcodebuild execution" {
  printf '%s\n' 'spawn(`xcodebuild`, ["test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a multiline direct xcodebuild execution" {
  printf '%s\n' 'spawn(' '  "xcodebuild",' '  ["test"],' ');' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects an absolute-path xcodebuild execution" {
  printf '%s\n' 'execFile("/usr/bin/xcodebuild", ["test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects an xcodebuild shell wrapper" {
  printf '%s\n' 'spawn("/bin/sh", ["-c", "xcodebuild test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects an xcodebuild executable variable" {
  printf '%s\n' 'const executable = "xcodebuild";' 'spawn(executable, ["test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects an aliased child-process import" {
  printf '%s\n' 'import { spawn as launch } from "node:child_process";' 'launch("xcodebuild", ["test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects an injected execution seam" {
  printf '%s\n' 'const command = "xcodebuild";' 'executor["executeCommand"](command, ["test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a computed child-process launcher" {
  printf '%s\n' 'import * as cp from "node:child_process";' 'cp["spawn"]("xcodebuild", ["test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects xcodebuild behind an env wrapper" {
  printf '%s\n' 'spawn("env", ["-i", "DEVELOPER_DIR=/Applications/Xcode.app", "xcodebuild", "test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects xcodebuild behind an absolute env wrapper" {
  printf '%s\n' 'execFile("/usr/bin/env", ["--unset", "SDKROOT", "xcodebuild", "test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a neutral injected exec seam" {
  printf '%s\n' 'runner.exec("xcodebuild -version");' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "allows XcodebuildClient to own direct execution" {
  printf '%s\n' 'spawn("xcodebuild", ["test"]);' > "$repo_dir/src/utils/ios-cmdline-tools/XcodebuildClient.ts"
  git -C "$repo_dir" add src/utils/ios-cmdline-tools/XcodebuildClient.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no new direct production xcodebuild invocations"* ]]
}
