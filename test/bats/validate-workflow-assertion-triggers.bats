#!/usr/bin/env bats
#
# Tests for scripts/ci/validate_workflow_assertion_triggers.sh

SCRIPT="scripts/ci/validate_workflow_assertion_triggers.sh"

setup() {
  FIXTURE_DIR="$(mktemp -d)"
  SWIFT_DIR="$FIXTURE_DIR/swift"
  mkdir -p "$SWIFT_DIR"
  WORKFLOW_FILE="$FIXTURE_DIR/pull_request.yml"
}

teardown() {
  rm -rf "$FIXTURE_DIR"
}

# Write a Swift test source asserting the given .github paths.
write_swift() {
  local out="$SWIFT_DIR/Fixture.swift"
  {
    echo "func t() throws {"
    for p in "$@"; do
      echo "    let workflow = try loadRepositoryFile(\"$p\")"
    done
    echo "}"
  } > "$out"
}

# Write a pull_request.yml with an ios: filter containing the given entries.
write_workflow() {
  {
    echo "      - name: \"Check for iOS-related changes\""
    echo "        id: filter-ios"
    echo "        with:"
    echo "          filters: |"
    echo "            ios:"
    for e in "$@"; do
      echo "              - '$e'"
    done
    echo ""
    echo "      - name: \"Next step\""
  } > "$WORKFLOW_FILE"
}

run_guard() {
  WORKFLOW_ASSERTION_SWIFT_DIR="$SWIFT_DIR" \
    WORKFLOW_ASSERTION_WORKFLOW_FILE="$WORKFLOW_FILE" \
    run bash "$SCRIPT"
}

@test "passes when every asserted .github path is listed verbatim in the ios filter" {
  write_swift ".github/workflows/nightly.yml" ".github/workflows/pull_request.yml"
  write_workflow "ios/**" ".github/workflows/nightly.yml" ".github/workflows/pull_request.yml"
  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" == *"asserted .github path(s) are covered"* ]]
}

@test "passes when a covering /** glob matches the asserted path" {
  write_swift ".github/workflows/nightly.yml"
  write_workflow "ios/**" ".github/workflows/**"
  run_guard
  [ "$status" -eq 0 ]
}

@test "passes when a single-level /* glob matches a path directly under the dir" {
  write_swift ".github/workflows/nightly.yml"
  write_workflow "ios/**" ".github/workflows/*"
  run_guard
  [ "$status" -eq 0 ]
}

@test "a single-level /* glob does not cover a nested path" {
  write_swift ".github/actions/foo/action.yml"
  write_workflow "ios/**" ".github/actions/*"
  run_guard
  [ "$status" -ne 0 ]
  [[ "$output" == *".github/actions/foo/action.yml"* ]]
}

@test "fails when an asserted .github path is missing from the ios filter" {
  write_swift ".github/workflows/nightly.yml" ".github/workflows/pull_request.yml"
  write_workflow "ios/**" ".github/workflows/pull_request.yml"
  run_guard
  [ "$status" -ne 0 ]
  [[ "$output" == *".github/workflows/nightly.yml"* ]]
}

@test "fails when the ios filter covers no .github path at all" {
  write_swift ".github/workflows/nightly.yml"
  write_workflow "ios/**" "scripts/ios/**"
  run_guard
  [ "$status" -ne 0 ]
}

@test "non-.github assertions are ignored" {
  write_swift "ios/XCTestRunner/Sources/XCTestRunner/AutoMobileTestCase.swift"
  write_workflow "ios/**"
  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" == *"No .github paths asserted"* ]]
}
