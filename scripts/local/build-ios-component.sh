#!/bin/bash

# Helper script to build a specific iOS component
# Usage: ./build-ios-component.sh <component-name>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# Build with the repository-pinned Xcode unless DEVELOPER_DIR already names one.
# Shell-test fixtures that copy this script without the helper keep the active Xcode.
if [[ -f "${PROJECT_ROOT}/scripts/ios/xcode_version.sh" ]]; then
  # shellcheck source=scripts/ios/xcode_version.sh
  source "${PROJECT_ROOT}/scripts/ios/xcode_version.sh"
  select_pinned_xcode
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <component-name>"
  echo ""
  echo "Available components:"
  echo "  XCTestRunner"
  exit 1
fi

COMPONENT="$1"
COMPONENT_PATH="${PROJECT_ROOT}/ios/${COMPONENT}"

if [[ ! -d "${COMPONENT_PATH}" ]]; then
  echo "❌ Error: Component '${COMPONENT}' not found at ${COMPONENT_PATH}"
  exit 1
fi

echo "Building ${COMPONENT}..."
echo "---"

# Check if it's a TypeScript component
if [[ -f "${COMPONENT_PATH}/package.json" ]]; then
  echo "Building TypeScript component..."
  (cd "${COMPONENT_PATH}" && bun install && bun run build)
else
  # Assume it's a Swift package
  echo "Building Swift component..."
  (cd "${COMPONENT_PATH}" && swift build)
fi

echo ""
echo "✓ ${COMPONENT} build successful"
