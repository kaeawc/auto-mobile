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

assert_cache_paths_exclude_package_resolution_state() {
  local workflow="$1"

  run awk '
    function indentation(line) {
      match(line, /[^[:space:]]/)
      return RSTART - 1
    }

    function check_path(path) {
      sub(/^[[:space:]]+/, "", path)
      sub(/[[:space:]]+$/, "", path)
      if (path ~ /\.build$/ || path ~ /SourcePackages$/) {
        print FILENAME ": forbidden actions/cache path: " path
        invalid = 1
      }
    }

    /^[[:space:]]*-[[:space:]]/ {
      is_cache_step = 0
      reading_path_block = 0
    }

    /uses:[[:space:]]*actions\/cache@/ {
      is_cache_step = 1
      next
    }

    is_cache_step && reading_path_block {
      if ($0 ~ /^[[:space:]]*$/) {
        next
      }
      if (indentation($0) <= path_indentation) {
        reading_path_block = 0
      } else {
        check_path($0)
        next
      }
    }

    is_cache_step && /^[[:space:]]*path:[[:space:]]*/ {
      path_indentation = indentation($0)
      path = $0
      sub(/^[[:space:]]*path:[[:space:]]*/, "", path)
      if (path == "|" || path == ">") {
        reading_path_block = 1
      } else {
        check_path(path)
      }
    }

    END {
      exit invalid
    }
  ' "$workflow"
  [ "$status" -eq 0 ]
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

@test "a valid + invalid name pair fails closed and names only the unmatched" {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script" Playground Typo
  [ "$status" -ne 0 ]
  [[ "$output" == *"Typo"* ]]
  # The error must list the unmatched request, not the valid one.
  [[ "$output" != *"matched: Playground"* ]]
}

@test "nested .xcodeproj below depth 2 (SwiftPM checkouts, build trees) is ignored" {
  mkdir -p "$ios_dir/XCTestRunner/.build/checkouts/Vendor/Sample.xcodeproj"
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Playground"* ]]
  [[ "$output" == *"CtrlProxy"* ]]
  [[ "$output" != *"Sample"* ]]
}

@test "workflow cache paths exclude SwiftPM build and package resolution state" {
  assert_cache_paths_exclude_package_resolution_state "$BATS_TEST_DIRNAME/../../.github/workflows/pull_request.yml"
  assert_cache_paths_exclude_package_resolution_state "$BATS_TEST_DIRNAME/../../.github/workflows/merge.yml"
  assert_cache_paths_exclude_package_resolution_state "$BATS_TEST_DIRNAME/../../.github/workflows/nightly.yml"
}
