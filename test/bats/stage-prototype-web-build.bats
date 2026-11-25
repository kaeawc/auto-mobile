#!/usr/bin/env bats
# bats file_tags=integration
#
# Runs scripts/release/stage-prototype-web.sh with the real build (#16455): the
# dry run CI uses to confirm the @kaeawc/auto-mobile-prototype-web tarball holds
# only the built entries and declarations, without changing the checkout.

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/release/stage-prototype-web.sh"
  STAGE="$BATS_TEST_TMPDIR/stage"
  export npm_config_cache="$BATS_TEST_TMPDIR/npm-cache"
}

@test "the real build stages a publishable tarball without touching the checkout" {
  local repo="$BATS_TEST_DIRNAME/../.."
  local before
  before="$(git -C "$repo" status --porcelain -- packages/prototype-web src/features/prototype/web)"
  run --separate-stderr "$SCRIPT" 1.2.3 "$STAGE"
  [ "$status" -eq 0 ]
  [ -s "$STAGE/dist/index.js" ]
  [ -s "$STAGE/dist/element.js" ]
  [ "$(git -C "$repo" status --porcelain -- packages/prototype-web src/features/prototype/web)" = "$before" ]
}
