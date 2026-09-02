#!/usr/bin/env bats
# bats file_tags=integration
#
# The macOS ScreenCaptureKit helper ships only as a signed GitHub Release asset.
# The npm tarball must never include its Swift source or a copied build tree.

@test "npm package excludes ScreenCaptureKit helper sources and build output" {
  run env "npm_config_cache=${BATS_TEST_TMPDIR}/npm-cache" npm pack --dry-run --json

  [ "$status" -eq 0 ]
  [[ "$output" != *"ios/screen-capture"* ]]
  [[ "$output" != *"dist/ios/screen-capture"* ]]
}
