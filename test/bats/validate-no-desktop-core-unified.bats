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
  local fixture_dir="android/desktop-core/src/test/kotlin/dev/jasonpearson/automobile/desktop"
  local fixture="$fixture_dir/__UnifiedReferenceGuardFixture.kt"
  mkdir -p "$fixture_dir"
  printf 'package dev.jasonpearson.automobile.desktop\nimport dev.jasonpearson.automobile.desktop.core.unified.UnifiedSocketClient\n' > "$fixture"
  run bash "$SCRIPT"
  rm -f "$fixture"
  [ "$status" -ne 0 ]
  [[ "$output" == *"desktop-core still references the deleted core.unified package"* ]]
}
