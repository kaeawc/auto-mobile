#!/usr/bin/env bats
#
# Pins the optional project-name filter of scripts/ios/xcode-build.sh, which lets
# CI shard the two Xcode projects (Playground, CtrlProxy) one per macOS runner so
# the required "iOS Build" leg builds them in parallel. The dry-run path
# (XCODE_BUILD_DRY_RUN=1) prints the selected projects without invoking xcodebuild,
# so this runs on any host — no Xcode required. Mirrors xcode-test-project-filter.bats.

setup() {
  ios_dir="$(mktemp -d)"
  mkdir -p "$ios_dir/Playground/Playground.xcodeproj"
  mkdir -p "$ios_dir/control-proxy/CtrlProxy.xcodeproj"
  script="$BATS_TEST_DIRNAME/../../scripts/ios/xcode-build.sh"
}

teardown() {
  rm -rf "$ios_dir"
}

@test "no args selects every xcodeproj" {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Playground"* ]]
  [[ "$output" == *"CtrlProxy"* ]]
}

@test "a project-name arg restricts the selection to that project" {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script" CtrlProxy
  [ "$status" -eq 0 ]
  [[ "$output" == *"CtrlProxy"* ]]
  [[ "$output" != *"Playground"* ]]
}

@test "the --dry-run flag is not treated as a project name" {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script" --dry-run Playground
  [ "$status" -eq 0 ]
  [[ "$output" == *"Playground"* ]]
  [[ "$output" != *"CtrlProxy"* ]]
}

@test "an unknown project-name arg fails closed (non-zero, no silent no-op)" {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script" Nonexistent
  [ "$status" -ne 0 ]
  [[ "$output" == *"no Xcode project"* ]]
  [[ "$output" == *"Nonexistent"* ]]
}
