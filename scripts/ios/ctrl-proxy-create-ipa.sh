#!/bin/bash
#
# CtrlProxy iOS Create IPA Script
# Builds CtrlProxy iOS and packages it as a distributable ZIP (named control-proxy.ipa)
#
# Usage:
#   ./scripts/ios/ctrl-proxy-create-ipa.sh [--output <path>] [--full-debug]
#
# Options:
#   --output <path>   Output path for the IPA file (default: ./control-proxy.ipa)
#   --full-debug      Include build-time objects and Swift module metadata
#
# Environment Variables:
#   GITHUB_OUTPUT   If set, outputs ipa_path and ipa_sha256 for GitHub Actions
#   CTRL_PROXY_IPA_FULL_DEBUG=1   Retain all build products for symbolication
#
# Outputs:
#   ipa_path    - Path to the generated IPA file
#   ipa_sha256  - SHA256 checksum of the IPA file

set -euo pipefail

# Parse arguments
OUTPUT_PATH="./control-proxy.ipa"
FULL_DEBUG="${CTRL_PROXY_IPA_FULL_DEBUG:-0}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --output)
            if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
                echo "--output requires a path" >&2
                exit 1
            fi
            OUTPUT_PATH="$2"
            shift 2
            ;;
        --full-debug)
            FULL_DEBUG=1
            shift
            ;;
        *)
            echo "Unknown argument: $1"
            exit 1
            ;;
    esac
done

# Resolve to absolute path (create parent directory if needed)
OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"
mkdir -p "$OUTPUT_DIR"
OUTPUT_PATH="$(cd "$OUTPUT_DIR" && pwd)/$(basename "$OUTPUT_PATH")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/xcodegen_version.sh
source "${SCRIPT_DIR}/xcodegen_version.sh"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CTRL_PROXY_IOS_DIR="${PROJECT_ROOT}/ios/control-proxy"
XCODEPROJ="${CTRL_PROXY_IOS_DIR}/CtrlProxy.xcodeproj"

# Use a temporary derived data path for clean builds
DERIVED_DATA="$(mktemp -d)/automobile-ctrl-proxy"

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  CtrlProxy iOS Create IPA${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Check prerequisites
if ! command -v xcodebuild &> /dev/null; then
    echo -e "${RED}Error: xcodebuild not found. Please install Xcode.${NC}"
    exit 1
fi

# Check the VERSION, not mere presence: a contributor who already has a
# different XcodeGen would otherwise skip the installer and regenerate a skewed
# project file — exactly the #3975 shape this pin exists to prevent. The
# installer no-ops when the pin is already satisfied.
echo -e "${YELLOW}Ensuring pinned XcodeGen ${XCODEGEN_VERSION}...${NC}"
"${SCRIPT_DIR}/install-xcodegen.sh"
hash -r 2>/dev/null || true
require_pinned_xcodegen_version

XCODE_VERSION=$(xcodebuild -version)
XCODE_VERSION=${XCODE_VERSION%%$'\n'*}
echo -e "${BLUE}Xcode version:${NC} ${XCODE_VERSION}"
echo -e "${BLUE}Derived data:${NC} ${DERIVED_DATA}"
echo -e "${BLUE}Output path:${NC} ${OUTPUT_PATH}"
echo ""

# Generate Xcode project if needed
if [ ! -d "${XCODEPROJ}" ]; then
    echo -e "${BLUE}Generating Xcode project...${NC}"
    cd "${CTRL_PROXY_IOS_DIR}"
    xcodegen generate
    cd "${PROJECT_ROOT}"
fi

# Build for testing
echo -e "${BLUE}Building CtrlProxy iOS for testing...${NC}"
echo ""

BUILD_START=$(date +%s)

xcodebuild build-for-testing \
    -project "${XCODEPROJ}" \
    -scheme "AutoMobileTest" \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "${DERIVED_DATA}" \
    -configuration Debug \
    CODE_SIGN_IDENTITY="-" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=NO \
    | xcpretty --color 2>/dev/null || true

BUILD_END=$(date +%s)
BUILD_DURATION=$((BUILD_END - BUILD_START))

# Verify build products
PRODUCTS_DIR="${DERIVED_DATA}/Build/Products"
SIM_DIR="${PRODUCTS_DIR}/Debug-iphonesimulator"

echo ""
echo -e "${BLUE}Verifying build products...${NC}"

XCTESTRUN_FILE=$(find "${PRODUCTS_DIR}" -name "*.xctestrun" -type f 2>/dev/null | head -1)

if [ -z "${XCTESTRUN_FILE}" ]; then
    echo -e "${RED}Error: No .xctestrun file found in ${PRODUCTS_DIR}${NC}"
    exit 1
fi

REQUIRED_ARTIFACTS=(
    "${SIM_DIR}/AutoMobileTest.app"
    "${SIM_DIR}/CtrlProxyUITests-Runner.app"
)

ALL_FOUND=true
for artifact in "${REQUIRED_ARTIFACTS[@]}"; do
    if [ -e "${artifact}" ]; then
        echo -e "  ${GREEN}✓${NC} $(basename "${artifact}")"
    else
        echo -e "  ${RED}✗${NC} $(basename "${artifact}") - MISSING"
        ALL_FOUND=false
    fi
done

echo -e "  ${GREEN}✓${NC} $(basename "${XCTESTRUN_FILE}")"

if [ "${ALL_FOUND}" = false ]; then
    echo ""
    echo -e "${RED}Error: Some required artifacts are missing${NC}"
    exit 1
fi

"${SCRIPT_DIR}/patch-ctrl-proxy-ui-test-runner-icon.sh" --derived-data "${DERIVED_DATA}"

echo ""
echo -e "${GREEN}Build completed in ${BUILD_DURATION}s${NC}"

# Create ZIP (named as .ipa)
echo ""
echo -e "${BLUE}Creating IPA archive...${NC}"

CTRL_PROXY_IPA_FULL_DEBUG="${FULL_DEBUG}" bash "${SCRIPT_DIR}/ctrl-proxy-package-ipa.sh" \
    --products "${DERIVED_DATA}/Build" --output "${OUTPUT_PATH}"

# Compute SHA256 of IPA
IPA_SHA256=$(shasum -a 256 "${OUTPUT_PATH}" | cut -d' ' -f1)
IPA_SIZE=$(stat -f%z "${OUTPUT_PATH}" 2>/dev/null || stat -c%s "${OUTPUT_PATH}" 2>/dev/null)
IPA_UNCOMPRESSED_SIZE=$(unzip -l "${OUTPUT_PATH}" | awk 'END {print $1}')

# Compute SHA256 of the CtrlProxy code executable. The outer
# CtrlProxyUITests-Runner binary is Xcode's generic XCTRunner stub; the xctest
# bundle is where the shipped CtrlProxy implementation lives.
RUNNER_BINARY="${SIM_DIR}/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests"
RUNNER_SHA256=$(shasum -a 256 "${RUNNER_BINARY}" | cut -d' ' -f1)

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  IPA Summary${NC}"
echo -e "${CYAN}========================================${NC}"
echo -e "  ${BLUE}Path:${NC}          ${OUTPUT_PATH}"
echo -e "  ${BLUE}Compressed:${NC}    ${IPA_SIZE} bytes"
echo -e "  ${BLUE}Uncompressed:${NC}  ${IPA_UNCOMPRESSED_SIZE} bytes"
echo -e "  ${BLUE}SHA256:${NC}        ${IPA_SHA256}"
echo -e "  ${BLUE}Runner SHA256:${NC} ${RUNNER_SHA256}"
echo ""

# Output for scripts and CI
echo "ipa_path=${OUTPUT_PATH}"
echo "ipa_sha256=${IPA_SHA256}"
echo "runner_sha256=${RUNNER_SHA256}"

# Output for GitHub Actions
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
        echo "ipa_path=${OUTPUT_PATH}"
        echo "ipa_sha256=${IPA_SHA256}"
        echo "runner_sha256=${RUNNER_SHA256}"
    } >> "${GITHUB_OUTPUT}"
fi

# Clean up temporary derived data
rm -rf "${DERIVED_DATA}"
