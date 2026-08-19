#!/usr/bin/env bats
#
# Pins the optional project-name filter of scripts/ios/xcode-test.sh (#5102).
# The CI Playground test job passes "Playground" so the heavier CtrlProxy tests
# (covered by the XCTestRunner simulator job) are not double-run. The dry-run
# path (XCODE_TEST_DRY_RUN=1) prints the selected projects without invoking
# xcodebuild, so this runs on any host — no Xcode required.

setup() {
  ios_dir="$(mktemp -d)"
  mkdir -p "$ios_dir/Playground/Playground.xcodeproj"
  mkdir -p "$ios_dir/control-proxy/CtrlProxy.xcodeproj"
  script="$BATS_TEST_DIRNAME/../../scripts/ios/xcode-test.sh"
}

teardown() {
  rm -rf "$ios_dir"
}

@test "no args selects every xcodeproj" {
  run env IOS_DIR="$ios_dir" XCODE_TEST_DRY_RUN=1 bash "$script"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Playground"* ]]
  [[ "$output" == *"CtrlProxy"* ]]
}

@test "a project-name arg restricts the selection to that project" {
  run env IOS_DIR="$ios_dir" XCODE_TEST_DRY_RUN=1 bash "$script" Playground
  [ "$status" -eq 0 ]
  [[ "$output" == *"Playground"* ]]
  [[ "$output" != *"CtrlProxy"* ]]
}

@test "an unknown project-name arg fails closed (non-zero, no silent no-op)" {
  run env IOS_DIR="$ios_dir" XCODE_TEST_DRY_RUN=1 bash "$script" Nonexistent
  [ "$status" -ne 0 ]
  [[ "$output" == *"no Xcode project"* ]]
  [[ "$output" == *"Nonexistent"* ]]
}
