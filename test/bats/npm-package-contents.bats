#!/usr/bin/env bats
# bats file_tags=integration
#
# The macOS ScreenCaptureKit helper ships only as a signed GitHub Release asset.
# The npm tarball must never include its Swift source or a copied build tree, and
# must include the usage skill the MCP server publishes.

bats_require_minimum_version 1.5.0

@test "untrimmed npm package excludes ScreenCaptureKit, ships the usage skill and preserves declarations without mutation" {
  run --separate-stderr env AUTOMOBILE_TRIM_BUNDLED_DEPS=false \
    "npm_config_cache=${BATS_TEST_TMPDIR}/npm-cache" npm pack --dry-run --json

  [ "$status" -eq 0 ]
  [[ "$output" != *"ios/screen-capture"* ]]
  [[ "$output" != *"dist/ios/screen-capture"* ]]
  # A stable declaration removed by enabled trimming witnesses the pinned mode.
  printf '%s' "$output" | node -e '
    const fs = require("node:fs");
    const files = JSON.parse(fs.readFileSync(0, "utf8"))[0].files;
    if (!files.some(file => file.path === "node_modules/zod/v4/classic/schemas.d.ts")) process.exit(1);
  '
  # The Skills over MCP usage skill is read from the package root at runtime.
  printf '%s' "$output" | node -e '
    const fs = require("node:fs");
    const files = JSON.parse(fs.readFileSync(0, "utf8"))[0].files;
    if (!files.some(file => file.path === "mcp-skills/auto-mobile-usage/SKILL.md")) process.exit(1);
  '
  [ "$(printf '%s\n' "$stderr" | sed -n '/^Bundled trim /p')" = \
    'Bundled trim disabled (local pack; set AUTOMOBILE_TRIM_BUNDLED_DEPS=true to enable).' ]
}
