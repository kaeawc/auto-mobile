#!/usr/bin/env bats
# bats file_tags=serial
# The fixture and baseline are restored after every test; run serially with source scans.

SCRIPT="scripts/check-utils-import-direction.sh"
FIXTURE="src/utils/UtilsImportDirectionFixture.ts"
BASELINE="scripts/utils-import-direction-baseline.txt"

setup() {
  SAVED_BASELINE="$(mktemp)"
  cp "$BASELINE" "$SAVED_BASELINE"
}

teardown() {
  rm -f "$FIXTURE"
  cp "$SAVED_BASELINE" "$BASELINE"
  rm -f "$SAVED_BASELINE"
}

@test "allows the current utils import baseline" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no new upward imports"* ]]
}

@test "allows the current utils import baseline with CRLF line endings" {
  awk '{ printf "%s\r\n", $0 }' "$SAVED_BASELINE" > "$BASELINE"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no new upward imports"* ]]
}

@test "rejects a new upward import edge" {
  printf '%s\n' 'import type { NewThing } from "../daemon/somethingNew";' > "$FIXTURE"

  run bash "$SCRIPT"

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

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"src/daemon/staticNew"* ]]
  [[ "$output" == *"src/server/reexportNew"* ]]
  [[ "$output" == *"src/features/dynamicNew"* ]]
  [[ "$output" == *"src/db/requireNew"* ]]
  [[ "$output" != *"src/ctrlProxy/futureModule"* ]]
  [[ "$output" != *"src/devices/futureModule"* ]]
}

@test "update removes stale edges from the baseline" {
  printf '%s\n' 'src/utils/OldFixture.ts -> src/daemon/oldTarget' >> "$BASELINE"

  run bash "$SCRIPT" --update

  [ "$status" -eq 0 ]
  ! grep -q 'src/utils/OldFixture.ts' "$BASELINE"
}

@test "update refuses growth unless explicitly allowed" {
  printf '%s\n' 'const { x } = require("../daemon/somethingNew");' > "$FIXTURE"
  before="$(cat "$BASELINE")"

  run bash "$SCRIPT" --update
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/utils/UtilsImportDirectionFixture.ts -> src/daemon/somethingNew"* ]]
  [ "$(cat "$BASELINE")" = "$before" ]

  run bash "$SCRIPT" --update --allow-grow
  [ "$status" -eq 0 ]
  grep -q 'src/utils/UtilsImportDirectionFixture.ts -> src/daemon/somethingNew' "$BASELINE"
}
