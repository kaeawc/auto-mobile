#!/usr/bin/env bats
# bats file_tags=serial
# Writes a fixture into the real source tree and scans it, so this file cannot
# run concurrently with the rest of the suite. scripts/ci/run-bats.sh runs all
# serial-tagged files in a dedicated serial pass (scripts/ci/run-bats.sh);
# the tag is enforced by test/scripts/batsSerialTags.test.ts.

SCRIPT="scripts/check-android-emulator-boundary.sh"
FIXTURE="src/utils/EmulatorBoundaryFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "allows AndroidEmulatorClient to own the emulator process boundary" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production emulator invocations"* ]]
}

@test "a comment mentioning the emulator does not opt a file into the rule" {
  # Regression: the scope pre-filter tested the RAW source for /emulator/i, so
  # prose alone pulled a file in. A doc comment on the iOS SimCtlClient that
  # merely referenced the Android emulator path was enough to flag that file's
  # long-standing, legitimate spawn() in defaultSpawnProcess. The pre-filter must
  # reflect what a file DOES, not what it talks about.
  printf '%s\n' \
    '/** Mirrors the readiness proof the Android emulator path performs. */' \
    'import { spawn } from "child_process";' \
    'export const run = () => spawn("xcrun", ["simctl", "list"]);' \
    '// emulator mentioned in a line comment too' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production emulator invocations"* ]]
}

@test "rejects a direct production emulator spawn outside the owner" {
  printf '%s\n' 'spawn("emulator", ["-list-avds"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects a direct production emulator spawn through a path variable" {
  printf '%s\n' 'spawn(emulatorPath, ["-avd", avdName]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects a direct production emulator spawn through an unrelated alias" {
  printf '%s\n' 'const executable = "emulator"; spawn(executable, ["-avd", avdName]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects a shell-based ProcessExecutor emulator launch" {
  printf '%s\n' 'const processExecutor: ProcessExecutor = {} as ProcessExecutor; processExecutor.exec("emulator -avd Pixel");' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects a synchronous child_process exec emulator launch" {
  printf '%s\n' 'import { execSync } from "node:child_process"; execSync("emulator -avd Pixel");' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects a synchronous child_process execFile emulator launch" {
  printf '%s\n' 'import { execFileSync } from "node:child_process"; execFileSync("emulator", ["-avd", "Pixel"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects a synchronous child_process spawn emulator launch" {
  printf '%s\n' 'import { spawnSync } from "node:child_process"; spawnSync("emulator", ["-avd", "Pixel"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects a synchronous child_process namespace emulator launch" {
  printf '%s\n' 'import * as childProcess from "node:child_process"; childProcess.execSync("emulator -avd Pixel");' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects a local alias of a synchronous child_process function" {
  printf '%s\n' 'import { execFileSync } from "node:child_process"; const launch = execFileSync; launch("emulator", ["-avd", "Pixel"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects a local alias of a synchronous child_process namespace method" {
  printf '%s\n' 'import * as childProcess from "node:child_process"; const launch = childProcess.execSync; launch("emulator -avd Pixel");' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects a CommonJS child_process namespace launch" {
  printf '%s\n' 'const childProcess = require("node:child_process"); childProcess.execSync("emulator -avd Pixel");' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "rejects an import-equals child_process namespace launch" {
  printf '%s\n' 'import childProcess = require("node:child_process"); childProcess.execSync("emulator -avd Pixel");' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"EmulatorBoundaryFixture.ts"* ]]
}

@test "allows unrelated RegExp exec calls in an emulator-related file" {
  printf '%s\n' 'const match = /emulator/.exec(deviceId);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
}
