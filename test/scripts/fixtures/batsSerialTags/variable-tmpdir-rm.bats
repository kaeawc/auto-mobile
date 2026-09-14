#!/usr/bin/env bats
# Fixture for test/scripts/batsSerialTags.test.ts: every rm/mv/redirect target
# lives under $BATS_TEST_TMPDIR, and the tracked path is only read (cp FROM it).
# Must NOT be recognized as a real-tree mutator.

ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SCRIPT="$ROOT/scripts/prepush-integration.sh"

@test "works on a temp copy of the runtime graph" {
  local runtime_input scratch_input renamed
  runtime_input="scripts/release/runtime-graph.json"
  scratch_input="$BATS_TEST_TMPDIR/runtime-graph.json"
  renamed="$BATS_TEST_TMPDIR/moved-runtime-graph.json"
  cp "$runtime_input" "$scratch_input"
  printf '{}' > "$scratch_input"
  mv "$scratch_input" "$renamed"
  rm -f "$renamed"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}
