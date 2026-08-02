#!/usr/bin/env bats
#
# Regression guard for #4955: the macOS DMG packaging must staple the
# notarization ticket to AutoMobile.app *inside* the DMG, not only to the DMG
# container. A ticket stapled only to the DMG does not travel when the user drags
# the app to /Applications, so offline first-launch falls back to an online
# notarization check.
#
# That requires: build the signed app-image (createDistributable) -> notarize and
# staple the app-image -> assemble the DMG from the stapled app-image
# (packageDmg wraps the app-image via jpackage --app-image) -> notarize and staple
# the DMG -> verify the app inside the shipped DMG is actually stapled, so a
# regression fails the release instead of shipping an unstapled app.
#
# Parsed with yq (the repo's canonical workflow parser, see
# release-workflow-wiring.bats), not grepped, so a value in a comment or another
# job cannot satisfy these assertions.

WORKFLOW=".github/workflows/build-desktop-app-installers.yml"

wiring_requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify desktop installer workflow wiring" >&2
    return 1
  fi
  skip "yq not installed"
}

@test "macOS packaging builds the app-image (createDistributable), not packageDmg directly" {
  wiring_requires_yq
  run yq -r '.jobs.build.strategy.matrix.include[] | select(.format == "dmg") | .["gradle-task"]' "$WORKFLOW"
  [ "$status" -eq 0 ]
  [[ "$output" == ":desktop-app:createDistributable" ]]
}

@test "the app image is notarized and stapled before the DMG is assembled" {
  wiring_requires_yq

  run yq -r '.jobs.build.steps[] | select(.name == "Notarize and staple app image") | .run' "$WORKFLOW"
  [ "$status" -eq 0 ]
  [[ "$output" == *"stapler staple"* ]]
  [[ "$output" == *"binaries/main/app"* ]]

  local app_idx dmg_assemble_idx dmg_staple_idx
  app_idx="$(yq -r '.jobs.build.steps | to_entries[] | select(.value.name == "Notarize and staple app image") | .key' "$WORKFLOW")"
  dmg_assemble_idx="$(yq -r '.jobs.build.steps | to_entries[] | select(.value.name == "Assemble DMG") | .key' "$WORKFLOW")"
  dmg_staple_idx="$(yq -r '.jobs.build.steps | to_entries[] | select(.value.name == "Notarize and staple DMG") | .key' "$WORKFLOW")"
  [ -n "$app_idx" ]
  [ -n "$dmg_assemble_idx" ]
  [ -n "$dmg_staple_idx" ]
  # app-image staple happens before the DMG is assembled, which happens before the
  # DMG is notarized/stapled.
  [ "$app_idx" -lt "$dmg_assemble_idx" ]
  [ "$dmg_assemble_idx" -lt "$dmg_staple_idx" ]
}

@test "the DMG is assembled with packageDmg from the already-stapled app image" {
  wiring_requires_yq
  run yq -r '.jobs.build.steps[] | select(.name == "Assemble DMG") | .with["gradle-tasks"]' "$WORKFLOW"
  [ "$status" -eq 0 ]
  [[ "$output" == *":desktop-app:packageDmg"* ]]
}

@test "the release verifies the app inside the shipped DMG is stapled (AC-1 enforcement)" {
  wiring_requires_yq
  # A dedicated step mounts the built DMG and stapler-validates the app INSIDE it,
  # so a regression that ships an unstapled app fails the release rather than
  # silently regressing offline first-launch.
  local run_block
  run_block="$(yq -r '.jobs.build.steps[] | select(.name == "Verify stapled app in DMG") | .run' "$WORKFLOW")"
  [ -n "$run_block" ]
  # Mounts the DMG, locates the .app inside the mount, and staples-validates it.
  [[ "$run_block" == *"hdiutil attach"* ]]
  [[ "$run_block" == *".app"* ]]
  [[ "$run_block" == *"stapler validate"* ]]

  # It runs after the DMG has been assembled and stapled.
  local dmg_staple_idx verify_idx
  dmg_staple_idx="$(yq -r '.jobs.build.steps | to_entries[] | select(.value.name == "Notarize and staple DMG") | .key' "$WORKFLOW")"
  verify_idx="$(yq -r '.jobs.build.steps | to_entries[] | select(.value.name == "Verify stapled app in DMG") | .key' "$WORKFLOW")"
  [ -n "$verify_idx" ]
  [ "$dmg_staple_idx" -lt "$verify_idx" ]
}

@test "the existing DMG notarize + staple is retained (AC-3: no regression)" {
  wiring_requires_yq
  run yq -r '.jobs.build.steps[] | select(.name == "Notarize and staple DMG") | .run' "$WORKFLOW"
  [ "$status" -eq 0 ]
  [[ "$output" == *'stapler staple "$DMG"'* ]]
}
