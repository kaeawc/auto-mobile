#!/usr/bin/env bats
#
# Guard against reintroducing phantom iOS Swift packages (issue #5080).
#
# `ios/AccessibilityService` and `ios/AXeAutomation` were referenced across the
# iOS build/validate tooling but never existed in the repo. Each site skipped
# them with a directory-existence guard, so they were harmless but misleading —
# a contributor reads them as real components. These assertions fail if either
# phantom name creeps back into the tooling that lists buildable components.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
}

# Assert $1 (repo-relative path) does not contain any of the remaining tokens.
refute_tokens() {
  local rel="$1"; shift
  local file="$REPO_ROOT/$rel"
  [ -f "$file" ] || { echo "missing file: $rel"; return 1; }
  local tok
  for tok in "$@"; do
    if grep -q "$tok" "$file"; then
      echo "phantom reference '$tok' still present in $rel"
      return 1
    fi
  done
}

@test "swift-build.sh has no AccessibilityService reference" {
  refute_tokens "scripts/ios/swift-build.sh" "AccessibilityService"
}

@test "swift-test.sh has no AccessibilityService reference" {
  refute_tokens "scripts/ios/swift-test.sh" "AccessibilityService"
}

@test "validate-ios-swift.sh lists no phantom Swift components" {
  refute_tokens "scripts/ci/validate-ios-swift.sh" "AccessibilityService" "AXeAutomation"
}

@test "validate-ios.sh lists no phantom Swift components" {
  refute_tokens "scripts/local/validate-ios.sh" "AccessibilityService" "AXeAutomation"
}

@test "build-ios-component.sh help lists no phantom components" {
  refute_tokens "scripts/local/build-ios-component.sh" "AccessibilityService" "AXeAutomation"
}

@test "test-ios-component.sh help lists no phantom components" {
  refute_tokens "scripts/local/test-ios-component.sh" "AccessibilityService" "AXeAutomation"
}

@test "ios/README.md no longer uses AccessibilityService as an example component" {
  refute_tokens "ios/README.md" "AccessibilityService"
}
