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

@test "skips cleanly when GH_TOKEN is unset (optional channel)" {
  cd "$TEST_ROOT"
  # No GH_TOKEN and not RENDER_ONLY: the publish is skipped before any network
  # or git work, so a missing tap token does not fail the release.
  run env -u GH_TOKEN -u RENDER_ONLY TAG=v0.0.26 REPO=kaeawc/auto-mobile \
    bash scripts/release/update-brew-formula.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping Homebrew formula publish"* ]]
}

@test "fails loudly when GH_TOKEN is unset and REQUIRE_TOKEN=1" {
  cd "$TEST_ROOT"
  # On a real tagged release the workflow sets REQUIRE_TOKEN=1, so a
  # missing/expired tap token must fail (surfaced) rather than silently
  # no-op the formula publish as it historically did.
  run env -u GH_TOKEN -u RENDER_ONLY TAG=v0.0.26 REPO=kaeawc/auto-mobile \
    REQUIRE_TOKEN=1 \
    bash scripts/release/update-brew-formula.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *"REQUIRE_TOKEN=1"* ]]
}

@test "rejects a zero-padded BREW_TARBALL_FETCH_ATTEMPTS override" {
  cd "$TEST_ROOT"
  # "08" is invalid octal in bash arithmetic; without up-front validation the
  # retry loop would spin forever. Must fail fast, before any fetch.
  run env TAG=v0.0.26 REPO=kaeawc/auto-mobile GH_TOKEN=x \
    BREW_TARBALL_FETCH_ATTEMPTS=08 \
    bash scripts/release/update-brew-formula.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *"BREW_TARBALL_FETCH_ATTEMPTS"* ]]
}

@test "rejects a non-numeric BREW_TARBALL_FETCH_DELAY_SECONDS override" {
  cd "$TEST_ROOT"
  run env TAG=v0.0.26 REPO=kaeawc/auto-mobile GH_TOKEN=x \
    BREW_TARBALL_FETCH_DELAY_SECONDS=abc \
    bash scripts/release/update-brew-formula.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *"BREW_TARBALL_FETCH_DELAY_SECONDS"* ]]
}

@test "exhausts the retry cap for a missing tarball and fails" {
  cd "$TEST_ROOT"
  # A version that will never resolve on the registry: the loop should try the
  # configured number of attempts, then exit non-zero with the count.
  run env TAG=v0.0.0-does-not-exist REPO=kaeawc/auto-mobile GH_TOKEN=x \
    BREW_TARBALL_FETCH_ATTEMPTS=2 BREW_TARBALL_FETCH_DELAY_SECONDS=0 \
    bash scripts/release/update-brew-formula.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *"after 2 attempts"* ]]
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

@test "RENDER_ONLY emits a livecheck block tracking the npm dist-tag" {
  cd "$TEST_ROOT"
  run env TAG=v0.0.26 REPO=kaeawc/auto-mobile RENDER_ONLY=1 \
    bash scripts/release/update-brew-formula.sh
  [ "$status" -eq 0 ]
  [ -f auto-mobile.rb ]

  grep -qF 'livecheck do' auto-mobile.rb
  grep -qF 'url "https://registry.npmjs.org/@kaeawc/auto-mobile"' auto-mobile.rb
  grep -qF 'json.dig("dist-tags", "latest")' auto-mobile.rb
}

@test "RENDER_ONLY uses the sanctioned formula_opt_bin path helper" {
  cd "$TEST_ROOT"
  # Homebrew/FormulaPathMethods rubocop cop: prefer formula_opt_bin("bun")
  # over Formula["bun"].opt_bin.
  run env TAG=v0.0.26 REPO=kaeawc/auto-mobile RENDER_ONLY=1 \
    bash scripts/release/update-brew-formula.sh
  [ "$status" -eq 0 ]
  grep -qF 'formula_opt_bin("bun")' auto-mobile.rb
  ! grep -qF 'Formula["bun"].opt_bin' auto-mobile.rb
}
