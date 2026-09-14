#!/usr/bin/env bats
# Fixture for test/scripts/batsSerialTags.test.ts: renames a tracked file with
# `git mv` through variables. Must be recognized as a real-tree mutator.

ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

@test "renames a tracked runtime-graph input via variables" {
  local from to
  from="scripts/release/runtime-graph.json"
  to="moved-runtime-graph.json"
  git -C "$ROOT" mv "$from" "$to"
  run bash "$ROOT/scripts/prepush-integration.sh"
  [ "$status" -eq 0 ]
}
