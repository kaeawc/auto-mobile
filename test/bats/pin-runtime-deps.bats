#!/usr/bin/env bats
#
# Guards the hermetic drift-check of the pinned runtime dependency graph (#5421).
# The pure pin/partition logic is covered by test/release/runtimePins.test.ts;
# these exercise the CLI's --check contract that CI (Fast Validation) depends on.

SCRIPT="scripts/release/pin-runtime-deps.ts"

@test "--check passes on the committed, in-sync graph" {
  run bun "$SCRIPT" --check
  [ "$status" -eq 0 ]
  [[ "$output" == *"in sync"* ]]
}

@test "--check fails when a runtime dependency is de-pinned to a range" {
  local package_backup result_status result_output
  package_backup="$(mktemp)"
  cp package.json "$package_backup"

  # Re-introduce a caret range on an existing exact pin.
  jq '.dependencies["sharp"] = "^0.35.3"' package.json > package.json.tmp
  mv package.json.tmp package.json

  run bun "$SCRIPT" --check
  result_status="$status"
  result_output="$output"

  cp "$package_backup" package.json
  rm -f "$package_backup"

  [ "$result_status" -eq 1 ]
  [[ "$result_output" == *"exact"* || "$result_output" == *"differ"* ]]
}

@test "unknown mode prints usage and exits non-zero" {
  run bun "$SCRIPT" --bogus
  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage"* ]]
}
