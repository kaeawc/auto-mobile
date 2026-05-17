#!/usr/bin/env bats
#
# Tests for scripts/release/update-brew-formula.sh

SCRIPT="scripts/release/update-brew-formula.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  mkdir -p "${TEST_ROOT}/scripts/release"
  cp "$SCRIPT" "${TEST_ROOT}/scripts/release/update-brew-formula.sh"
  chmod +x "${TEST_ROOT}/scripts/release/update-brew-formula.sh"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "rejects invocation without TAG" {
  cd "$TEST_ROOT"
  run env -u TAG REPO=kaeawc/auto-mobile RENDER_ONLY=1 \
    bash scripts/release/update-brew-formula.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *"TAG"* ]]
}

@test "rejects invocation without REPO" {
  cd "$TEST_ROOT"
  run env -u REPO TAG=v0.0.26 RENDER_ONLY=1 \
    bash scripts/release/update-brew-formula.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *"REPO"* ]]
}

@test "RENDER_ONLY writes a formula with the resolved sha256" {
  cd "$TEST_ROOT"
  run env TAG=v0.0.26 REPO=kaeawc/auto-mobile RENDER_ONLY=1 \
    bash scripts/release/update-brew-formula.sh
  [ "$status" -eq 0 ]
  [ -f auto-mobile.rb ]

  expected_url="https://registry.npmjs.org/@kaeawc/auto-mobile/-/auto-mobile-0.0.26.tgz"
  grep -qF "url \"${expected_url}\"" auto-mobile.rb
  grep -qE '^  sha256 "[0-9a-f]{64}"$' auto-mobile.rb
  grep -qF 'depends_on "bun"' auto-mobile.rb
  grep -qF 'homepage "https://github.com/kaeawc/auto-mobile"' auto-mobile.rb
}
