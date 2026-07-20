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
