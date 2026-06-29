#!/usr/bin/env bats
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
