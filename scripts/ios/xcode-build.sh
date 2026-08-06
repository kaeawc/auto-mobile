#!/bin/bash
#
# Xcode Project Build Script
# Builds Xcode projects (xcodeproj) for iOS simulator
#

set -e

# Options
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dry-run)
            DRY_RUN=true
            ;;
        *)
            ;;
    esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/xcodegen_version.sh disable=SC1091
source "${SCRIPT_DIR}/xcodegen_version.sh"
# shellcheck source=scripts/ios/local-sim-build-args.sh disable=SC1091
source "${SCRIPT_DIR}/local-sim-build-args.sh"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IOS_DIR="${PROJECT_ROOT}/ios"

# On a local arm64 host, build only the arch the simulator runs and skip the
# index store; empty in CI / on Intel so those keep building universal (#5024).
LOCAL_SIM_ARGS=()
while IFS= read -r _arg; do
    [ -n "${_arg}" ] && LOCAL_SIM_ARGS+=("${_arg}")
done < <(local_sim_build_args)

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Xcode Project Build${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Track overall status
OVERALL_STATUS=0
BUILT_PROJECTS=()
FAILED_PROJECTS=()

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

run_cmd() {
    if [ "$DRY_RUN" = true ]; then
        echo -e "  ${YELLOW}↳${NC} (dry-run) $*"
        return 0
    fi
    "$@"
}

has_simulator_sdk() {
    if [ "$DRY_RUN" = true ]; then
        echo -e "${YELLOW}(dry-run) Skipping simulator SDK detection.${NC}"
        return 0
    fi
    # Check both that the SDK is listed AND that simulator runtimes are available.
    # On Xcode 26+, the iOS platform may need a separate download even if SDK
    # headers appear in -showsdks.
    xcodebuild -showsdks 2>/dev/null | grep -q "iphonesimulator" \
        && xcrun simctl list runtimes 2>/dev/null | grep -qiE "^iOS "
}

# Check if xcodebuild is available
if ! command -v xcodebuild &> /dev/null; then
    echo -e "${RED}Error: xcodebuild not found. Please install Xcode.${NC}"
    exit 1
fi

XCODE_VERSION=$(xcodebuild -version)
XCODE_VERSION=${XCODE_VERSION%%$'\n'*}
print_info "Xcode version: ${XCODE_VERSION}"

DESTINATION="generic/platform=iOS Simulator"
print_info "Using iOS destination: ${DESTINATION}"
echo ""

# Ensure iOS Simulator SDK is installed
if ! has_simulator_sdk; then
    echo -e "${YELLOW}No iOS Simulator SDK detected. Attempting to install iOS platform...${NC}"
    set +e
    run_cmd xcodebuild -downloadPlatform iOS 2>&1
    DOWNLOAD_EXIT_CODE=$?
    set -e

    if [ $DOWNLOAD_EXIT_CODE -ne 0 ]; then
        echo -e "${RED}Failed to download iOS platform (exit ${DOWNLOAD_EXIT_CODE}).${NC}"
    fi

    if ! has_simulator_sdk; then
        echo -e "${RED}iOS Simulator SDK still missing after download attempt.${NC}"
        echo -e "${YELLOW}Install the iOS platform in Xcode or ensure CI has the simulator SDK preinstalled.${NC}"
        exit 1
    fi
fi

# Install the pinned xcodegen (needed to regenerate projects for Xcode version
# compatibility). Checks the VERSION, not mere presence: a machine that already
# has a different XcodeGen would otherwise regenerate every project skewed —
# the #3975 shape. The installer no-ops when the pin is already satisfied, and
# the old `command -v brew` guard is gone because it no longer uses Homebrew.
print_info "Ensuring pinned xcodegen ${XCODEGEN_VERSION}..."
"${SCRIPT_DIR}/install-xcodegen.sh" || echo "xcodegen install failed, continuing with committed projects"
hash -r 2>/dev/null || true

# Regenerate only with the pinned version. This path tolerates a failed install
# by falling back to the committed projects, so a skew is a warn-and-skip here
# rather than a hard failure — but it must never regenerate with a skewed
# generator, which would silently rewrite every ios/*/project.pbxproj.
# Read the version by invoking the binary directly rather than through
# installed_xcodegen_version(): a *function* call inside a command substitution
# silently disables set -e for it (SC2311), and this script tolerates a missing
# xcodegen, so it must not rely on errexit here anyway.
current_xcodegen_version="$(xcodegen --version 2>/dev/null | awk '{ gsub(/\r/, ""); print $NF; exit }')"
if [ "${current_xcodegen_version}" != "${XCODEGEN_VERSION}" ]; then
    print_info "xcodegen ${current_xcodegen_version:-none} != pinned ${XCODEGEN_VERSION}; using committed projects"
elif command -v xcodegen &> /dev/null; then
    echo -e "${BLUE}Regenerating Xcode projects from project.yml...${NC}"
    shopt -s nullglob
    PROJECT_YMLS=("${IOS_DIR}"/*/project.yml)
    shopt -u nullglob
    for yml in "${PROJECT_YMLS[@]}"; do
        yml_dir=$(dirname "$yml")
        yml_name=$(basename "$yml_dir")
        echo -e "  Generating ${yml_name}..."
        if (cd "$yml_dir" && xcodegen generate 2>&1); then
            echo -e "  ${GREEN}✓${NC} ${yml_name} regenerated"
        else
            echo -e "  ${YELLOW}⚠${NC} ${yml_name} generation failed, using committed project"
        fi
    done
    echo ""
fi

# Find all xcodeproj directories using glob (faster than find)
echo -e "${BLUE}Searching for Xcode projects...${NC}"
shopt -s nullglob
XCODEPROJ_ARRAY=("${IOS_DIR}"/*/*.xcodeproj "${IOS_DIR}"/*.xcodeproj)
shopt -u nullglob

if [ ${#XCODEPROJ_ARRAY[@]} -eq 0 ]; then
    echo -e "${YELLOW}No Xcode projects found in ${IOS_DIR}${NC}"
    exit 0
fi

# Build each project
for xcodeproj in "${XCODEPROJ_ARRAY[@]}"; do
    PROJECT_NAME=$(basename "${xcodeproj}" .xcodeproj)

    echo -e "  Building ${PROJECT_NAME}..."

    # Get available schemes
    SCHEMES=$(run_cmd xcodebuild -project "${xcodeproj}" -list 2>/dev/null | sed -n '/Schemes:/,/^$/p' | grep -v "Schemes:" | sed 's/^[[:space:]]*//' | grep -v '^$' || true)

    if [ -z "${SCHEMES}" ]; then
        print_info "No schemes found for ${PROJECT_NAME}, skipping"
        continue
    fi

    # Build each scheme for iOS simulator
    BUILD_SUCCESS=true
    while IFS= read -r scheme; do
        if [ -n "${scheme}" ]; then
            echo -e "    Building scheme: ${scheme}..."
            set +e
            BUILD_LOG=$(run_cmd xcodebuild \
                -project "${xcodeproj}" \
                -scheme "${scheme}" \
                -destination "${DESTINATION}" \
                -configuration Debug \
                -quiet \
                CODE_SIGN_IDENTITY="-" \
                CODE_SIGNING_REQUIRED=NO \
                CODE_SIGNING_ALLOWED=NO \
                "${LOCAL_SIM_ARGS[@]}" \
                build 2>&1)
            XCODE_EXIT=$?
            set -e
            if [ $XCODE_EXIT -eq 0 ]; then
                echo -e "    ${GREEN}✓${NC} ${scheme} built"
            else
                echo -e "    ${RED}✗${NC} ${scheme} failed"
                # Emit error lines as GitHub Actions annotations for CI visibility
                echo "$BUILD_LOG" | grep -iE "error:" | head -20 | while IFS= read -r line; do
                    echo "::error::${scheme}: ${line}"
                done
                BUILD_SUCCESS=false
            fi
        fi
    done <<< "${SCHEMES}"

    if [ "${BUILD_SUCCESS}" = true ]; then
        print_status 0 "${PROJECT_NAME} built successfully"
        BUILT_PROJECTS+=("${PROJECT_NAME}")
    else
        print_status 1 "${PROJECT_NAME} build failed"
        FAILED_PROJECTS+=("${PROJECT_NAME}")
    fi
done
echo ""

# Summary
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Build Summary${NC}"
echo -e "${CYAN}========================================${NC}"

if [ ${#BUILT_PROJECTS[@]} -gt 0 ]; then
    echo -e "${GREEN}Built:${NC}"
    for proj in "${BUILT_PROJECTS[@]}"; do
        echo -e "  ${GREEN}✓${NC} ${proj}"
    done
fi

if [ ${#FAILED_PROJECTS[@]} -gt 0 ]; then
    echo -e "${RED}Failed:${NC}"
    for proj in "${FAILED_PROJECTS[@]}"; do
        echo -e "  ${RED}✗${NC} ${proj}"
    done
fi

echo ""
if [ $OVERALL_STATUS -eq 0 ]; then
    echo -e "${GREEN}All Xcode projects built successfully!${NC}"
else
    echo -e "${RED}Some projects failed to build!${NC}"
fi

exit $OVERALL_STATUS
