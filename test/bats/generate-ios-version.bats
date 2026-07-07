#!/usr/bin/env bats
#
# Tests for scripts/versioning/generate-ios-version.sh
#
# The generator is the single source of truth for the XCTestRunner's baked
# version constant: it renders ios/XCTestRunner/.../AutoMobileVersion.swift from
# the canonical package.json version so the constant can never be hand-edited
# into drift. `--check` is the drift gate CI runs.

SCRIPT_SRC="scripts/versioning/generate-ios-version.sh"
SWIFT_REL="ios/XCTestRunner/Sources/XCTestRunner/AutoMobileVersion.swift"

setup() {
  TEST_ROOT="$(mktemp -d)"
  SCRIPT_ABS="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)/$(basename "$SCRIPT_SRC")"
  mkdir -p "${TEST_ROOT}/ios/XCTestRunner/Sources/XCTestRunner"
  write_fixtures
}

teardown() {
  rm -rf "$TEST_ROOT"
}

write_fixtures() {
  cat > "${TEST_ROOT}/package.json" <<'EOF'
{ "name": "@kaeawc/auto-mobile", "version": "1.2.3" }
EOF
}

run_generate() {
  run bash -c "cd '${TEST_ROOT}' && bash '${SCRIPT_ABS}' $*"
}

@test "write mode renders the baked constant from package.json" {
  run_generate
  [ "$status" -eq 0 ]
  [ -f "${TEST_ROOT}/${SWIFT_REL}" ]
  grep -q 'public static let current = "1.2.3"' "${TEST_ROOT}/${SWIFT_REL}"
}

@test "generated file carries a DO NOT EDIT / generated marker" {
  run_generate
  [ "$status" -eq 0 ]
  grep -qi "do not edit" "${TEST_ROOT}/${SWIFT_REL}"
  grep -q "generate-ios-version.sh" "${TEST_ROOT}/${SWIFT_REL}"
}

@test "generated file preserves the public AutoMobileVersion API surface" {
  run_generate
  [ "$status" -eq 0 ]
  grep -q "public enum AutoMobileVersion" "${TEST_ROOT}/${SWIFT_REL}"
  grep -q "public static let current" "${TEST_ROOT}/${SWIFT_REL}"
}

@test "write mode is idempotent" {
  run_generate
  [ "$status" -eq 0 ]
  first="$(cat "${TEST_ROOT}/${SWIFT_REL}")"
  run_generate
  [ "$status" -eq 0 ]
  second="$(cat "${TEST_ROOT}/${SWIFT_REL}")"
  [ "$first" = "$second" ]
}

@test "--check passes when the committed file matches package.json" {
  run_generate
  [ "$status" -eq 0 ]
  run_generate --check
  [ "$status" -eq 0 ]
}

@test "--check fails when the committed file has drifted from package.json" {
  run_generate
  [ "$status" -eq 0 ]
  # Simulate a hand-edit / stale bump: change package.json but not the swift file.
  cat > "${TEST_ROOT}/package.json" <<'EOF'
{ "name": "@kaeawc/auto-mobile", "version": "9.9.9" }
EOF
  run_generate --check
  [ "$status" -ne 0 ]
  [[ "$output" == *"drift"* || "$output" == *"9.9.9"* ]]
}

@test "--check does not modify the committed file" {
  run_generate
  [ "$status" -eq 0 ]
  before="$(cat "${TEST_ROOT}/${SWIFT_REL}")"
  run_generate --check
  after="$(cat "${TEST_ROOT}/${SWIFT_REL}")"
  [ "$before" = "$after" ]
}
