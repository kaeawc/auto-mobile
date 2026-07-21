#!/usr/bin/env bats

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

@test "allows unrelated RegExp exec calls in an emulator-related file" {
  printf '%s\n' 'const match = /emulator/.exec(deviceId);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
}
