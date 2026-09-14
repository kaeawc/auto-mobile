#!/usr/bin/env bats
# bats file_tags=serial
# Writes a fixture into the real src/ tree and scans it, so this file cannot
# run concurrently with the rest of the suite (scripts/ci/run-bats.sh runs
# serial-tagged files in a dedicated pass; the tag is enforced by
# test/scripts/batsSerialTags.test.ts).
#
# Tests for scripts/validate-no-debug-log-tags.sh

SCRIPT="scripts/validate-no-debug-log-tags.sh"

@test "passes when no stray [*-DEBUG] log tags exist in src/" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No stray [*-DEBUG] log tags found in src/."* ]]
}

@test "fails when a [*-DEBUG] log tag is present in src/" {
  local tmp="src/__debug_tag_guard_fixture__.ts"
  printf 'export const x = "[DEVICE-POOL-DEBUG] leftover";\n' > "$tmp"
  run bash "$SCRIPT"
  rm -f "$tmp"
  [ "$status" -ne 0 ]
  [[ "$output" == *"stray [*-DEBUG] log tag"* ]]
}
