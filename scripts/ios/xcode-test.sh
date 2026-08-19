#!/bin/bash
#
# Xcode Project Test Script
# Runs tests for Xcode projects (xcodeproj) on iOS simulator
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/local-sim-build-args.sh disable=SC1091
source "${SCRIPT_DIR}/local-sim-build-args.sh"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# IOS_DIR is overridable (tests point it at a fixture dir); defaults to ios/.
IOS_DIR="${IOS_DIR:-${PROJECT_ROOT}/ios}"

# Optional positional args restrict which Xcode projects get tested, by name
# (without the .xcodeproj suffix). With no args, every project under ios/ is
# tested (legacy behavior). CI's Playground job passes "Playground" so the
# heavier CtrlProxy tests (covered by the XCTestRunner simulator job) are not
# double-run here.
REQUESTED_PROJECTS=("$@")

# Discover and filter projects up front so a dry run needs no Xcode. The dry run
# (XCODE_TEST_DRY_RUN=1) prints the selected project names and exits, which is
# how test/bats/xcode-test-project-filter.bats pins the filter on any host. The
# match is inlined (rather than a helper invoked in an `if`) so `set -e` stays
# active for the rest of the loop body (shellcheck SC2310).
SELECTED_XCODEPROJ_DIRS=()
while IFS= read -r _xcodeproj; do
    [ -z "${_xcodeproj}" ] && continue
    _name="$(basename "${_xcodeproj}" .xcodeproj)"
    _match=0
    if [ ${#REQUESTED_PROJECTS[@]} -eq 0 ]; then
        # No filter given: every project is selected (legacy behavior).
        _match=1
    else
        for _want in "${REQUESTED_PROJECTS[@]}"; do
            [ "${_want}" = "${_name}" ] && _match=1
        done
    fi
    [ "${_match}" -eq 1 ] && SELECTED_XCODEPROJ_DIRS+=("${_xcodeproj}")
done < <(find "${IOS_DIR}" -name "*.xcodeproj" -type d 2>/dev/null || true)

# Fail closed: an explicit filter that matches nothing is a misconfiguration
# (e.g. a renamed project), not a reason to pass a gating job with zero tests.
# With no filter, an empty result is handled later as a benign no-op.
if [ ${#REQUESTED_PROJECTS[@]} -ne 0 ] && [ ${#SELECTED_XCODEPROJ_DIRS[@]} -eq 0 ]; then
    echo "Error: no Xcode project under ${IOS_DIR} matched: ${REQUESTED_PROJECTS[*]}" >&2
    exit 1
fi

if [ "${XCODE_TEST_DRY_RUN:-0}" = "1" ]; then
    for _xcodeproj in "${SELECTED_XCODEPROJ_DIRS[@]}"; do
        basename "${_xcodeproj}" .xcodeproj
    done
    exit 0
fi

# On a local arm64 host, build only the arch the simulator runs and skip the
# index store; empty in CI / on Intel so those keep building universal (#5024).
LOCAL_SIM_ARGS=()
while IFS= read -r _arg; do
    [ -n "${_arg}" ] && LOCAL_SIM_ARGS+=("${_arg}")
done < <(local_sim_build_args)

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Xcode Project Tests${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Track overall status
OVERALL_STATUS=0
TESTED_PROJECTS=()
FAILED_PROJECTS=()
SKIPPED_PROJECTS=()

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

print_warning() {
    echo -e "  ${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "  ${BLUE}ℹ${NC} $1"
}

# Check if xcodebuild is available
if ! command -v xcodebuild &> /dev/null; then
    echo -e "${RED}Error: xcodebuild not found. Please install Xcode.${NC}"
    exit 1
fi

XCODE_VERSION=$(xcodebuild -version | head -1)
print_info "Xcode version: ${XCODE_VERSION}"

# Find an available iOS simulator
# First try to find a booted one, then fall back to any available iPhone simulator
find_simulator() {
    # Look for a booted iPhone simulator
    local booted_sim
    booted_sim=$(xcrun simctl list devices booted 2>/dev/null | grep -E "iPhone.*Booted" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/')
    if [ -n "${booted_sim}" ]; then
        echo "${booted_sim}"
        return
    fi

    # No booted simulator - look for any available iPhone simulator
    local available_sim
    available_sim=$(xcrun simctl list devices available 2>/dev/null | grep -E "iPhone 16[^e]" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/')
    if [ -n "${available_sim}" ]; then
        echo "${available_sim}"
        return
    fi

    # Fall back to any iPhone
    available_sim=$(xcrun simctl list devices available 2>/dev/null | grep -E "iPhone" | head -1 | sed -E 's/.*\(([A-F0-9-]+)\).*/\1/')
    echo "${available_sim}"
}

SIMULATOR_ID=$(find_simulator)
if [ -z "${SIMULATOR_ID}" ]; then
    echo -e "${YELLOW}Warning: No iOS simulator available. Xcode tests will be skipped.${NC}"
    echo -e "${YELLOW}To run tests, create a simulator: xcrun simctl create 'iPhone 16' 'iPhone 16'${NC}"
    echo ""
    exit 0
fi

# Get simulator name for display
SIMULATOR_NAME=$(xcrun simctl list devices 2>/dev/null | grep "${SIMULATOR_ID}" | sed -E 's/^[[:space:]]+([^(]+).*/\1/' | sed 's/[[:space:]]*$//')
print_info "Using simulator: ${SIMULATOR_NAME} (${SIMULATOR_ID})"
echo ""

# Build destination string
DESTINATION="platform=iOS Simulator,id=${SIMULATOR_ID}"

# Projects were discovered and filtered up front (see SELECTED_XCODEPROJ_DIRS).
echo -e "${BLUE}Testing Xcode projects: ${SELECTED_XCODEPROJ_DIRS[*]:-none}${NC}"

if [ ${#SELECTED_XCODEPROJ_DIRS[@]} -eq 0 ]; then
    echo -e "${YELLOW}No matching Xcode projects found in ${IOS_DIR}${NC}"
    exit 0
fi

# Test each project
for xcodeproj in "${SELECTED_XCODEPROJ_DIRS[@]}"; do
    PROJECT_NAME=$(basename "${xcodeproj}" .xcodeproj)

    echo -e "  Testing ${PROJECT_NAME}..."

    # Get available schemes
    SCHEMES=$(xcodebuild -project "${xcodeproj}" -list 2>/dev/null | sed -n '/Schemes:/,/^$/p' | grep -v "Schemes:" | sed 's/^[[:space:]]*//' | grep -v '^$' || true)

    if [ -z "${SCHEMES}" ]; then
        print_warning "${PROJECT_NAME} has no schemes, skipping"
        SKIPPED_PROJECTS+=("${PROJECT_NAME} (no schemes)")
        continue
    fi

    # Prefer the scheme whose name matches the project (e.g. Playground.xcodeproj
    # → the "Playground" scheme, which wires the PlaygroundTests test action).
    # xcodebuild -list also surfaces auto-generated schemes for dependency
    # targets (e.g. "AutoMobileSDK") that have no test action and can sort first,
    # so a blind `head -1` would try to test the wrong scheme. Fall back to the
    # first scheme when no name matches (preserves legacy single-scheme behavior).
    TEST_SUCCESS=true
    TESTS_RAN=false
    FIRST_SCHEME=$(echo "${SCHEMES}" | grep -Fx "${PROJECT_NAME}" | head -1 || true)
    [ -z "${FIRST_SCHEME}" ] && FIRST_SCHEME=$(echo "${SCHEMES}" | head -1)

    if [ -n "${FIRST_SCHEME}" ]; then
        echo -e "    Testing scheme: ${FIRST_SCHEME}..."

        # Try to run tests
        if xcodebuild \
            -project "${xcodeproj}" \
            -scheme "${FIRST_SCHEME}" \
            -destination "${DESTINATION}" \
            -configuration Debug \
            -quiet \
            "${LOCAL_SIM_ARGS[@]}" \
            test 2>&1; then
            echo -e "    ${GREEN}✓${NC} ${FIRST_SCHEME} tests passed"
            TESTS_RAN=true
        else
            echo -e "    ${RED}✗${NC} ${FIRST_SCHEME} tests failed"
            TEST_SUCCESS=false
            TESTS_RAN=true
        fi
    fi

    if [ "${TESTS_RAN}" = false ]; then
        print_warning "${PROJECT_NAME} has no test targets"
        SKIPPED_PROJECTS+=("${PROJECT_NAME} (no tests)")
    elif [ "${TEST_SUCCESS}" = true ]; then
        print_status 0 "${PROJECT_NAME} tests passed"
        TESTED_PROJECTS+=("${PROJECT_NAME}")
    else
        print_status 1 "${PROJECT_NAME} tests failed"
        FAILED_PROJECTS+=("${PROJECT_NAME}")
    fi
done
echo ""

# Summary
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Test Summary${NC}"
echo -e "${CYAN}========================================${NC}"

if [ ${#TESTED_PROJECTS[@]} -gt 0 ]; then
    echo -e "${GREEN}Passed:${NC}"
    for proj in "${TESTED_PROJECTS[@]}"; do
        echo -e "  ${GREEN}✓${NC} ${proj}"
    done
fi

if [ ${#SKIPPED_PROJECTS[@]} -gt 0 ]; then
    echo -e "${YELLOW}Skipped:${NC}"
    for proj in "${SKIPPED_PROJECTS[@]}"; do
        echo -e "  ${YELLOW}⚠${NC} ${proj}"
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
    echo -e "${GREEN}All Xcode tests passed!${NC}"
else
    echo -e "${RED}Some tests failed!${NC}"
fi

exit $OVERALL_STATUS
