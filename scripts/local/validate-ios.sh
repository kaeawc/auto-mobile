#!/bin/bash

# Local validation script for iOS components
# Includes additional checks and detailed output for local development

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "========================================="
echo "iOS Components Validation (Local)"
echo "========================================="
echo ""

# Check platform
if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ Error: iOS development requires macOS"
  echo "   Current platform: $(uname)"
  exit 1
fi

echo "✓ Running on macOS $(sw_vers -productVersion)"
echo ""

# Check Xcode
if ! command -v xcodebuild &>/dev/null; then
  echo "❌ Error: Xcode not found"
  echo "   Please install Xcode from the App Store"
  exit 1
fi

XCODE_VERSION=$(xcodebuild -version | head -n 1)
echo "✓ ${XCODE_VERSION}"
echo ""

# Check Swift
if ! command -v swift &>/dev/null; then
  echo "❌ Error: Swift not found"
  exit 1
fi

echo "✓ Swift version: $(swift --version | head -n 1)"
echo ""

# Check Bun
if ! command -v bun &>/dev/null; then
  echo "❌ Error: Bun not found"
  echo "   Please install bun: https://bun.sh"
  exit 1
fi

echo "✓ Bun version: $(bun --version)"
echo ""

# Check for simctl. `command -v xcrun simctl` treats `simctl` as a second
# command name (not a PATH binary), so it always failed regardless of whether
# `xcrun simctl` actually works — probe the subcommand directly instead (#3652).
if ! xcrun simctl help &>/dev/null; then
  echo "⚠️  Warning: simctl not found"
  echo "   Some functionality may not work"
else
  echo "✓ simctl available"
fi

echo ""
echo "========================================="
echo "Building Swift Components"
echo "========================================="
echo ""

SWIFT_COMPONENTS=(
  "ios/XCTestRunner"
)

FAILED_BUILDS=()
PASSED_BUILDS=()

for component in "${SWIFT_COMPONENTS[@]}"; do
  component_path="${PROJECT_ROOT}/${component}"

  if [[ ! -d "${component_path}" ]]; then
    echo "⚠️  ${component} not found, skipping"
    continue
  fi

  echo "Building ${component}..."

  # Run the build once and classify by its exit status. Previously the result
  # was inferred from a `swift build 2>&1 | grep ...` pipeline, but under
  # `set -o pipefail` a failing build made the pipeline non-zero even when grep
  # matched the error line — so the `if` was false and the component was added
  # to NEITHER PASSED_BUILDS nor FAILED_BUILDS, and the script reported success
  # despite a broken build (#3637).
  if build_output=$(cd "${component_path}" && swift build 2>&1); then
    build_ok=true
  else
    build_ok=false
  fi

  # Surface the interesting lines (errors/warnings/progress) without deciding
  # pass/fail from grep's exit status.
  echo "${build_output}" | grep -E "(error:|warning:|Compiling|Linking|Build complete)" || true

  if [[ "${build_ok}" == true ]]; then
    echo "✓ ${component} build successful"
    PASSED_BUILDS+=("${component}")
  else
    echo "❌ ${component} build failed"
    FAILED_BUILDS+=("${component}")
  fi

  echo ""
done

echo "========================================="
echo "Running Tests"
echo "========================================="
echo ""

# Run Swift tests
for component in "${SWIFT_COMPONENTS[@]}"; do
  component_path="${PROJECT_ROOT}/${component}"

  if [[ ! -d "${component_path}" ]]; then
    continue
  fi

  echo "Testing ${component}..."

  if (cd "${component_path}" && swift test 2>&1); then
    echo "✓ ${component} tests passed"
  else
    echo "⚠️  ${component} tests failed or unavailable"
  fi

  echo ""
done

echo "========================================="
echo "Validation Summary"
echo "========================================="
echo ""

echo "Build Results:"
echo "  Passed: ${#PASSED_BUILDS[@]}"
for component in ${PASSED_BUILDS[@]+"${PASSED_BUILDS[@]}"}; do
  echo "    ✓ ${component}"
done
echo ""

if [[ ${#FAILED_BUILDS[@]} -gt 0 ]]; then
  echo "  Failed: ${#FAILED_BUILDS[@]}"
  for component in "${FAILED_BUILDS[@]}"; do
    echo "    ❌ ${component}"
  done
  echo ""
  echo "❌ Validation failed"
  exit 1
fi

echo "✓ All iOS components validated successfully"
echo ""
echo "Next steps:"
echo "  - Run individual component tests with 'swift test' in each directory"
echo "  - Build for iOS Simulator with xcodebuild"
echo "  - Test integration with MCP server"
echo ""

exit 0
