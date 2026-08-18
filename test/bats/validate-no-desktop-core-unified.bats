#!/usr/bin/env bats
#
# Tests for scripts/android/validate-no-desktop-core-unified.sh

SCRIPT="scripts/android/validate-no-desktop-core-unified.sh"

@test "passes when the desktop-core unified socket-client package is absent" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No desktop-core unified socket-client package or references found."* ]]
}

@test "passes when invoked outside the repo root" {
  run bash -c "cd .. && bash '$PWD/$SCRIPT'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No desktop-core unified socket-client package or references found."* ]]
}

@test "fails when a core.unified package reference is present" {
  # Build the offending reference in a TEMP root and point the script at it via
  # its root-override argument. Writing the fixture into the real tree raced
  # the sibling "passes when absent" tests under `bats --jobs`: they scanned
  # the repository while the fixture existed and failed spuriously.
  local tmp_root
  tmp_root="$(mktemp -d)"
  local fixture_dir="$tmp_root/android/desktop-core/src/test/kotlin/dev/jasonpearson/automobile/desktop"
  mkdir -p "$fixture_dir"
  printf 'package dev.jasonpearson.automobile.desktop\nimport dev.jasonpearson.automobile.desktop.core.unified.UnifiedSocketClient\n' \
    > "$fixture_dir/__UnifiedReferenceGuardFixture.kt"
  run bash "$SCRIPT" "$tmp_root"
  rm -rf "$tmp_root"
  [ "$status" -ne 0 ]
  [[ "$output" == *"desktop-core still references the deleted core.unified package"* ]]
}

@test "fails when the unified package directory itself is present" {
  local tmp_root
  tmp_root="$(mktemp -d)"
  mkdir -p "$tmp_root/android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/unified"
  run bash "$SCRIPT" "$tmp_root"
  rm -rf "$tmp_root"
  [ "$status" -ne 0 ]
  [[ "$output" == *"unified socket-client package still exists"* ]]
}
