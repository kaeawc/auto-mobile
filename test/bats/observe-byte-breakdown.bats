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
  # Full-line matches so a stray "7 bytes" elsewhere can't satisfy the assertion,
  # and the "(embeds gfxinfoRaw)" suffix (the duplication signal) is pinned.
  [[ "$output" == *"metrics.gfxinfoRaw: 7 bytes"* ]]
  [[ "$output" == *"diagnostics: 20 bytes (embeds gfxinfoRaw)"* ]]
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
  # Anchor to the Top-level section only: sub-key names (e.g. systemInsets) also
  # appear in the viewHierarchy block and could otherwise fool the line compare.
  section="$(echo "$output" | sed -n '/Top-level fields/,/^$/p')"
  vh_line="$(echo "$section" | grep -n 'viewHierarchy' | head -1 | cut -d: -f1)"
  ss_line="$(echo "$section" | grep -n 'screenSize' | head -1 | cut -d: -f1)"
  [ "$vh_line" -lt "$ss_line" ]
}

@test "handles a minimal observe result with no viewHierarchy or performanceAudit" {
  echo '{"screenSize":{"width":1,"height":2}}' > "${TEST_ROOT}/minimal.json"
  run bash "$SCRIPT" "${TEST_ROOT}/minimal.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"(no viewHierarchy)"* ]]
  [[ "$output" == *"(no performanceAudit)"* ]]
}

@test "rejects non-object JSON (array/scalar) with a clean error" {
  run bash -c "echo '[1,2,3]' | bash '$SCRIPT' -"
  [ "$status" -ne 0 ]
  [[ "$output" == *"expected a JSON object"* ]]
}

@test "does not crash on non-string gfxinfoRaw / diagnostics" {
  echo '{"performanceAudit":{"metrics":{"gfxinfoRaw":12345},"diagnostics":{"o":1}}}' \
    > "${TEST_ROOT}/malformed.json"
  run bash "$SCRIPT" "${TEST_ROOT}/malformed.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"metrics.gfxinfoRaw:"* ]]
}

@test "does not hang on the large fixture in a UTF-8 locale" {
  # Regression guard for the ${var//[[:space:]]/} perf cliff, which only
  # manifested in a multibyte locale.
  run env LC_ALL=en_US.UTF-8 timeout 20 bash "$SCRIPT" "test/fixtures/observe/android-home.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"performanceAudit"* ]]
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
  run bash "$SCRIPT" "test/fixtures/observe/android-home.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"performanceAudit"* ]]
  [[ "$output" == *"viewHierarchy sub-keys"* ]]
}
