#!/usr/bin/env bats
# Fixture for test/scripts/batsSerialTags.test.ts: deletes a tracked file through
# a variable. Must be recognized as a real-tree mutator (needs the serial tag).

ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

@test "deletes a tracked runtime-graph input via a variable" {
  local runtime_input base_ref
  runtime_input="scripts/release/runtime-graph.json"
  base_ref="$(git -C "$ROOT" rev-parse HEAD)"
  rm "$runtime_input"
  run bash "$ROOT/scripts/prepush-integration.sh"
  [ "$status" -eq 0 ]
}
