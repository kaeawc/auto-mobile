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

@test "rejects env assignments after the option terminator" {
  printf '%s\n' 'spawn("env", ["--", "DEVELOPER_DIR=/Applications/Xcode.app", "xcodebuild", "test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects an attached env split-string payload" {
  printf '%s\n' 'spawn("env", ["-Sxcodebuild -version"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "continues after a split-string assignment" {
  printf '%s\n' 'spawn("env", ["-S", "DEVELOPER_DIR=/Applications/Xcode.app", "xcodebuild", "test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a shell wrapper produced by env split-string" {
  printf '%s\n' "spawn(\"env\", [\"-S\", \"sh -c 'xcodebuild test'\"]);" > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "preserves GNU env escaped split-string separators" {
  printf '%s\n' 'spawn("env", ["-S", "FOO=bar \\_ xcodebuild test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "preserves GNU env escaped whitespace separators" {
  printf '%s\n' 'spawn("env", ["-S", String.raw`FOO=bar\txcodebuild test`]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "honors GNU env split-string termination" {
  printf '%s\n' 'spawn("env", ["-S", String.raw`tool \c xcodebuild test`]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no new direct production xcodebuild invocations"* ]]
}

@test "fails closed for bundled env short options" {
  printf '%s\n' 'spawn("env", ["-iS", "xcodebuild test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "rejects a path-qualified shell produced by env split-string" {
  printf '%s\n' "spawn(\"env\", [\"-S\", \"/usr/bin/bash -c 'xcodebuild test'\"]);" > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "preserves String.raw split-string options" {
  printf '%s\n' 'spawn("env", [String.raw`--split-string=xcodebuild -version`]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "preserves a dynamic environment assignment as one argv slot" {
  printf '%s\n' 'spawn("env", [`DEVELOPER_DIR=${developerDir}`, "xcodebuild", "test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "preserves an unresolved environment argument before xcodebuild" {
  printf '%s\n' 'spawn("env", [environmentArgument, "xcodebuild", "test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "fails closed for an unresolved array-form command" {
  printf '%s\n' 'Bun.spawn([wrapper, "xcodebuild", "test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "fails closed for an unresolved string-form command" {
  printf '%s\n' 'spawn(commandVariable, ["-S", "xcodebuild test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "preserves a literal command branch beside a dynamic template" {
  printf '%s\n' 'Bun.spawn([condition ? "xcodebuild" : `tool-${name}`, "test"]);' > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "fails closed when conditional argv alternatives exceed the analysis bound" {
  {
    printf '%s' 'spawn("env", ['
    for index in $(seq 1 20); do
      printf '%s' "condition${index} ? \"NAME${index}=a\" : \"NAME${index}=b\","
    done
    printf '%s\n' '"xcodebuild", "test"]);'
  } > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "fails closed when one concatenated slot exceeds the analysis bound" {
  {
    printf '%s' 'Bun.spawn(['
    for index in $(seq 1 20); do
      printf '%s' "(condition${index} ? \"a\" : \"b\") + "
    done
    printf '%s\n' '"xcodebuild", "test"]);'
  } > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "bounds repeated conditional alias branches" {
  {
    printf '%s\n' 'const a0 = condition ? "xcodebuild" : "tool";'
    for index in $(seq 1 25); do
      previous=$((index - 1))
      printf 'const a%s = condition ? a%s : a%s;\n' "$index" "$previous" "$previous"
    done
    printf '%s\n' 'spawn(a25, ["test"]);'
  } > "$repo_dir/src/bypass.ts"
  git -C "$repo_dir" add src/bypass.ts

  run bash -c 'cd "$1" && bash scripts/check-no-new-direct-xcodebuild.sh HEAD' _ "$repo_dir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"bypass.ts"* ]]
}

@test "does not stop before xcodebuild after one thousand env assignments" {
  {
    printf '%s' 'spawn("env", ['
    for index in $(seq 1 1000); do
      printf '"NAME%s=value",' "$index"
    done
    printf '%s\n' '"xcodebuild", "test"]);'
  } > "$repo_dir/src/bypass.ts"
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
