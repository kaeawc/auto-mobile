#!/usr/bin/env bats
# bats file_tags=serial
# Writes a fixture into the real source tree and scans it, so this file cannot
# run concurrently with the rest of the suite. scripts/ci/run-bats.sh runs all
# serial-tagged files in a dedicated serial pass (scripts/ci/run-bats.sh);
# the tag is enforced by test/scripts/batsSerialTags.test.ts.

SCRIPT="scripts/check-app-bundle-metadata-boundary.sh"
FIXTURE="src/utils/CodesignBoundaryFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "allows AppBundleMetadataClient to own codesign execution" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production codesign invocations"* ]]
}

@test "rejects direct codesign execution outside the owner" {
  printf '%s\n' 'hostExec("codesign", ["-d", appPath]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"CodesignBoundaryFixture.ts"* ]]
}

@test "rejects a codesign path stored in a variable" {
  printf '%s\n' 'const tool = "codesign"; hostExec(tool, ["-d", appPath]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"CodesignBoundaryFixture.ts"* ]]
}

@test "rejects no-substitution template and absolute-path codesign invocations" {
  printf '%s\n' 'hostExec(`codesign`, ["-d", appPath]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"CodesignBoundaryFixture.ts"* ]]

  printf '%s\n' 'execFile("/usr/bin/codesign", ["-d", appPath]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"CodesignBoundaryFixture.ts"* ]]
}

@test "rejects xcrun, Bun.spawn, and concatenated aliases" {
  printf '%s\n' 'execFile("xcrun", ["codesign", "-d", appPath]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"CodesignBoundaryFixture.ts"* ]]

  printf '%s\n' 'Bun.spawn(["codesign", "-d", appPath]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"CodesignBoundaryFixture.ts"* ]]

  printf '%s\n' 'const tool = "code" + "sign"; hostExec(tool, ["-d", appPath]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"CodesignBoundaryFixture.ts"* ]]
}
