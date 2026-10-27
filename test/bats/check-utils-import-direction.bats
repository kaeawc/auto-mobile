#!/usr/bin/env bats
# bats file_tags=serial
# The fixture is removed after every test; run serially with source scans.

SCRIPT="scripts/check-utils-import-direction.ts"
FIXTURE="src/utils/UtilsImportDirectionFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "passes with no upward imports" {
  run bun "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no upward imports"* ]]
}

@test "rejects an upward import edge" {
  printf '%s\n' 'import type { NewThing } from "../daemon/somethingNew";' > "$FIXTURE"

  run bun "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"src/utils/UtilsImportDirectionFixture.ts -> src/daemon/somethingNew"* ]]
}

@test "finds static, re-export, dynamic, and CommonJS edges" {
  printf '%s\n' \
    'import { x } from "../daemon/staticNew";' \
    'export { y } from "../server/reexportNew";' \
    'const lazy = await import("../features/dynamicNew");' \
    'const { z } = require("../db/requireNew") as typeof import("../db/requireNew");' \
    'import type { Safe } from "../ctrlProxy/futureModule";' \
    'import type { Device } from "../devices/futureModule";' \
    > "$FIXTURE"

  run bun "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"src/daemon/staticNew"* ]]
  [[ "$output" == *"src/server/reexportNew"* ]]
  [[ "$output" == *"src/features/dynamicNew"* ]]
  [[ "$output" == *"src/db/requireNew"* ]]
  [[ "$output" != *"src/ctrlProxy/futureModule"* ]]
  [[ "$output" != *"src/devices/futureModule"* ]]
}
