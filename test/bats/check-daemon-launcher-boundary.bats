#!/usr/bin/env bats
# bats file_tags=serial
# Writes a fixture into the real source tree and scans it, so this file cannot
# run concurrently with the rest of the suite. scripts/ci/run-bats.sh runs all
# serial-tagged files in a dedicated serial pass (scripts/ci/run-bats.sh);
# the tag is enforced by test/scripts/batsSerialTags.test.ts.

SCRIPT="scripts/check-daemon-launcher-boundary.sh"
FIXTURE="src/daemon/DaemonLauncherBoundaryFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "allows DaemonLauncher to own daemon execution" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production daemon invocations"* ]]
}

@test "rejects a direct daemon spawn outside the owner" {
  printf '%s\n' \
    'import { spawn } from "node:child_process";' \
    'spawn("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects a shell daemon command outside the owner" {
  printf '%s\n' \
    'import { execSync } from "node:child_process";' \
    'execSync("bunx @kaeawc/auto-mobile --daemon-mode");' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects CommonJS and aliased child-process execution outside the owner" {
  printf '%s\n' \
    'const { spawn } = require("node:child_process");' \
    'const launch = spawn;' \
    'launch(command, daemonArgs);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects import-equals child-process execution outside the owner" {
  printf '%s\n' \
    'import childProcess = require("node:child_process");' \
    'childProcess.execSync(command);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}
