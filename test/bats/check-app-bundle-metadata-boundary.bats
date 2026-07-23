#!/usr/bin/env bats

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
