#!/usr/bin/env bats
#
# Tests for scripts/observe-byte-breakdown.sh
#
# The script is the measurement half of the MCP output-context reduction
# harness (issue #2755): given any observe-result JSON it prints a byte
# breakdown by top-level field and by viewHierarchy sub-key.

SCRIPT="scripts/observe-byte-breakdown.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  # Minimal but structurally faithful observe result with known byte sizes.
  # gfxinfoRaw "RAWDUMP" is 7 bytes; diagnostics "before RAWDUMP after" is 20.
  cat > "${TEST_ROOT}/observe.json" <<'JSON'
{
  "screenSize": { "width": 1, "height": 2 },
  "viewHierarchy": {
    "hierarchy": { "node": [ { "text": "aaaaaaaaaaaaaaaaaaaa" } ] },
    "packageName": "com.example"
  },
  "elements": { "clickable": [], "text": [] },
  "performanceAudit": {
    "metrics": { "gfxinfoRaw": "RAWDUMP" },
    "diagnostics": "before RAWDUMP after"
  }
}
JSON

  # A wrapped payload (homeScreen-style) that nests the observe under .observation.
  cat > "${TEST_ROOT}/wrapped.json" <<'JSON'
{
  "message": "Pressed home button",
  "observation": {
    "screenSize": { "width": 1, "height": 2 },
    "viewHierarchy": { "hierarchy": { "node": [] }, "packageName": "com.x" },
    "elements": { "clickable": [] }
  }
}
JSON
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "prints total byte count of the observe result" {
  run bash "$SCRIPT" "${TEST_ROOT}/observe.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Total:"* ]]
  [[ "$output" == *"bytes"* ]]
}

@test "emits per-top-level-field byte counts" {
  run bash "$SCRIPT" "${TEST_ROOT}/observe.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Top-level fields"* ]]
  [[ "$output" == *"performanceAudit"* ]]
  [[ "$output" == *"viewHierarchy"* ]]
  [[ "$output" == *"elements"* ]]
  [[ "$output" == *"screenSize"* ]]
}

@test "emits per-viewHierarchy-sub-key byte counts" {
  run bash "$SCRIPT" "${TEST_ROOT}/observe.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"viewHierarchy sub-keys"* ]]
  [[ "$output" == *"hierarchy"* ]]
  [[ "$output" == *"packageName"* ]]
}

@test "surfaces the gfxinfoRaw / diagnostics duplication with exact byte counts" {
  run bash "$SCRIPT" "${TEST_ROOT}/observe.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"gfxinfoRaw"* ]]
  [[ "$output" == *"7 bytes"* ]]
  [[ "$output" == *"diagnostics"* ]]
  [[ "$output" == *"20 bytes"* ]]
}

@test "reads observe JSON from stdin" {
  run bash -c "cat '${TEST_ROOT}/observe.json' | bash '$SCRIPT' -"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Top-level fields"* ]]
  [[ "$output" == *"performanceAudit"* ]]
}

@test "auto-unwraps a .observation wrapper (homeScreen-style payload)" {
  run bash "$SCRIPT" "${TEST_ROOT}/wrapped.json"
  [ "$status" -eq 0 ]
  # After unwrapping, viewHierarchy is a top-level field, not "observation".
  [[ "$output" == *"viewHierarchy"* ]]
  [[ "$output" != *"observation"* ]]
}

@test "sorts top-level fields by descending byte count" {
  run bash "$SCRIPT" "${TEST_ROOT}/observe.json"
  [ "$status" -eq 0 ]
  # viewHierarchy is the largest field here; it must appear before screenSize.
  vh_line="$(echo "$output" | grep -n 'viewHierarchy' | head -1 | cut -d: -f1)"
  ss_line="$(echo "$output" | grep -n 'screenSize' | head -1 | cut -d: -f1)"
  [ "$vh_line" -lt "$ss_line" ]
}

@test "exits non-zero with a message when the file does not exist" {
  run bash "$SCRIPT" "${TEST_ROOT}/missing.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not found"* ]]
}

@test "exits non-zero on invalid JSON" {
  echo "not json" > "${TEST_ROOT}/bad.json"
  run bash "$SCRIPT" "${TEST_ROOT}/bad.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"valid JSON"* ]]
}

@test "runs against the committed real home-screen fixture" {
  run bash "$SCRIPT" "test/fixtures/observe/android-home-66k.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"performanceAudit"* ]]
  [[ "$output" == *"viewHierarchy sub-keys"* ]]
}
