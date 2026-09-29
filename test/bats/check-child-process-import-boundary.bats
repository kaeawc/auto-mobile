#!/usr/bin/env bats
# bats file_tags=serial
# Writes a fixture into the real source tree and scans it, so this file cannot
# run concurrently with the rest of the suite. scripts/ci/run-bats.sh runs all
# serial-tagged files in a dedicated serial pass (scripts/ci/run-bats.sh);
# the tag is enforced by test/scripts/batsSerialTags.test.ts.

SCRIPT="scripts/check-child-process-import-boundary.sh"
FIXTURE="src/utils/ChildProcessBoundaryFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "allows the current production importers" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no unlisted production imports"* ]]
}

@test "rejects a new child_process import" {
  printf '%s\n' 'import { execFile } from "child_process";' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ChildProcessBoundaryFixture.ts"* ]]
}

@test "rejects import equals and require forms" {
  printf '%s\n' 'import child = require("node:child_process"); const other = require("child_process");' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ChildProcessBoundaryFixture.ts"* ]]
}
