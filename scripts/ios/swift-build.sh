#!/bin/bash
#
# Swift Package Build Script
# Builds all Swift packages in the ios directory
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IOS_DIR="${PROJECT_ROOT}/ios"

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Swift Package Build${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Track overall status
OVERALL_STATUS=0
FAILED_PACKAGES=()

# Helper function to print status
print_status() {
    local status=$1
    local message=$2
    if [ "$status" -eq 0 ]; then
        echo -e "  ${GREEN}✓${NC} $message"
    else
        echo -e "  ${RED}✗${NC} $message"
        OVERALL_STATUS=1
    fi
}

print_info() {
    echo -e "  ${BLUE}ℹ${NC} $1"
}

# Check if swift is available
if ! command -v swift &> /dev/null; then
    echo -e "${RED}Error: swift command not found${NC}"
    exit 1
fi

SWIFT_VERSION=$(swift --version | head -1)
print_info "Swift version: ${SWIFT_VERSION}"
echo ""

# macOS packages (can be built and tested on macOS)
MACOS_PACKAGES=(
    "screen-capture"
    "network-filter"
    "audio-loopback"
    "carplay-power"
)

# iOS + macOS packages (have both platform support)
IOS_MACOS_PACKAGES=(
    "sdk-wire"
    "auto-mobile-sdk"
    "control-proxy"
    "XCTestRunner"
)

# Build macOS packages
echo -e "${BLUE}Building macOS packages...${NC}"
for package in "${MACOS_PACKAGES[@]}"; do
    PACKAGE_DIR="${IOS_DIR}/${package}"
    if [ -f "${PACKAGE_DIR}/Package.swift" ]; then
        echo -e "  Building ${package}..."
        if (cd "${PACKAGE_DIR}" && swift build -Xswiftc -warnings-as-errors 2>&1); then
            print_status 0 "${package} built successfully"
        else
            print_status 1 "${package} build failed"
            FAILED_PACKAGES+=("${package}")
        fi
    else
        print_info "Skipping ${package} (no Package.swift)"
    fi
done
echo ""

# Optional: sign macOS products with Developer ID when credentials are available.
if [[ "${MACOS_SIGNING_ENABLED:-false}" == "true" ]]; then
    echo -e "${BLUE}Signing macOS products for release builds...${NC}"
    if "${SCRIPT_DIR}/sign-macos-products.sh"; then
        print_status 0 "macOS products signed successfully"
    else
        print_status 1 "macOS product signing failed"
        FAILED_PACKAGES+=("macOS product signing")
    fi
    echo ""
fi

# Build iOS + macOS packages (build for macOS platform on CI)
echo -e "${BLUE}Building iOS + macOS packages...${NC}"
for package in "${IOS_MACOS_PACKAGES[@]}"; do
    PACKAGE_DIR="${IOS_DIR}/${package}"
    if [ -f "${PACKAGE_DIR}/Package.swift" ]; then
        echo -e "  Building ${package}..."
        if (cd "${PACKAGE_DIR}" && swift build -Xswiftc -warnings-as-errors 2>&1); then
            print_status 0 "${package} built successfully"
        else
            print_status 1 "${package} build failed"
            FAILED_PACKAGES+=("${package}")
        fi
    else
        print_info "Skipping ${package} (no Package.swift)"
    fi
done
echo ""

# The iOS simulator prototype apps (agent dylib, viewer, ProtoViewer) are not SwiftPM targets; see
# swift-build-prototype-apps.sh. SWIFT_BUILD_PROTOTYPE_APPS=skip leaves them out for a CI job that
# builds them in a separate matrix job (#18429); every other value builds them here.
if [[ "${SWIFT_BUILD_PROTOTYPE_APPS:-all}" == "skip" ]]; then
    print_info "Skipping iOS simulator prototype apps (SWIFT_BUILD_PROTOTYPE_APPS=skip)"
    echo ""
elif ! "${SCRIPT_DIR}/swift-build-prototype-apps.sh" all; then
    print_status 1 "prototype app build failed"
    FAILED_PACKAGES+=("prototype apps")
fi

# The CarPlay projection probe targets the iOS 27.0 simulator; build it whenever that SDK exists so
# probe.m cannot rot unseen. Its JSON keys are checked against the TypeScript schema by unit tests.
echo -e "${BLUE}Building CarPlay projection probe...${NC}"
SIM_SDK_VERSION="$(xcrun --sdk iphonesimulator --show-sdk-version 2> /dev/null || true)"
if [[ "${SIM_SDK_VERSION%%.*}" =~ ^[0-9]+$ ]] && (( ${SIM_SDK_VERSION%%.*} >= 27 )); then
    if bash "${IOS_DIR}/carplay-projection-probe/build.sh" \
        "${PROJECT_ROOT}/scratch/carplay-projection-probe-ci/carplay-projection-probe" 2>&1; then
        print_status 0 "carplay-projection-probe built successfully"
    else
        print_status 1 "carplay-projection-probe build failed"
        FAILED_PACKAGES+=("carplay-projection-probe")
    fi
else
    print_info "Skipping carplay-projection-probe (needs iphonesimulator SDK 27+, found '${SIM_SDK_VERSION:-none}')"
fi
echo ""

# Optional: sign XCTestRunner for iOS releases when credentials are available.
if [[ "${IOS_SIGNING_ENABLED:-false}" == "true" ]]; then
    echo -e "${BLUE}Signing iOS frameworks for release builds...${NC}"
    if "${SCRIPT_DIR}/sign-ios-frameworks.sh"; then
        print_status 0 "iOS frameworks signed successfully"
    else
        print_status 1 "iOS framework signing failed"
        FAILED_PACKAGES+=("iOS framework signing")
    fi
    echo ""
fi

# Summary
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Build Summary${NC}"
echo -e "${CYAN}========================================${NC}"
if [ ${#FAILED_PACKAGES[@]} -eq 0 ]; then
    echo -e "${GREEN}All packages built successfully!${NC}"
else
    echo -e "${RED}Failed packages:${NC}"
    for pkg in "${FAILED_PACKAGES[@]}"; do
        echo -e "  ${RED}✗${NC} ${pkg}"
    done
fi

exit $OVERALL_STATUS
