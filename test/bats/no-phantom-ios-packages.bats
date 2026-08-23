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

# ---------------------------------------------------------------------------
# SimctlIntegration (issue #5089). A third phantom: unlike the two above it was
# described as a TypeScript component, so it also polluted the TS-validation
# path. No real TypeScript iOS component exists, so the phantom-only CI script
# scripts/ci/validate-ios-typescript.sh was removed along with its invocation
# from scripts/ci/validate-ios.sh.
# ---------------------------------------------------------------------------

@test "phantom-only CI script validate-ios-typescript.sh was removed" {
  local file="$REPO_ROOT/scripts/ci/validate-ios-typescript.sh"
  if [ -e "$file" ]; then
    echo "phantom-only script scripts/ci/validate-ios-typescript.sh still present"
    return 1
  fi
}

@test "validate-ios.sh (ci) no longer invokes the removed TypeScript validation" {
  refute_tokens "scripts/ci/validate-ios.sh" "SimctlIntegration" "validate-ios-typescript"
}

@test "validate-ios.sh (local) lists no SimctlIntegration reference" {
  refute_tokens "scripts/local/validate-ios.sh" "SimctlIntegration"
}

@test "build-ios-component.sh help lists no SimctlIntegration component" {
  refute_tokens "scripts/local/build-ios-component.sh" "SimctlIntegration"
}

@test "test-ios-component.sh help lists no SimctlIntegration component" {
  refute_tokens "scripts/local/test-ios-component.sh" "SimctlIntegration"
}

@test "ios/README.md no longer references SimctlIntegration" {
  refute_tokens "ios/README.md" "SimctlIntegration"
}
