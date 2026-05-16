#!/usr/bin/env bats
#
# Tests for scripts/release/update-brew-formula.sh

SCRIPT="scripts/release/update-brew-formula.sh"
FORMULA_SRC="Formula/auto-mobile.rb"

setup() {
  TEST_ROOT="$(mktemp -d)"
  mkdir -p "${TEST_ROOT}/Formula" "${TEST_ROOT}/scripts/release"
  cp "$SCRIPT" "${TEST_ROOT}/scripts/release/update-brew-formula.sh"
  cp "$FORMULA_SRC" "${TEST_ROOT}/Formula/auto-mobile.rb"
  chmod +x "${TEST_ROOT}/scripts/release/update-brew-formula.sh"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "rejects invocation without a version argument" {
  run bash "${TEST_ROOT}/scripts/release/update-brew-formula.sh"
  [ "$status" -eq 64 ]
  [[ "$output" == *"usage:"* ]]
}

@test "rewrites url and sha256 for the requested npm version" {
  cd "$TEST_ROOT"
  run bash "scripts/release/update-brew-formula.sh" 0.0.26
  [ "$status" -eq 0 ]
  expected_url="https://registry.npmjs.org/@kaeawc/auto-mobile/-/auto-mobile-0.0.26.tgz"
  grep -q "url \"${expected_url}\"" Formula/auto-mobile.rb
  # SHA line should be a 64-char hex digest
  sha_line="$(grep -E '^  sha256 "[0-9a-f]{64}"$' Formula/auto-mobile.rb || true)"
  [ -n "$sha_line" ]
}
