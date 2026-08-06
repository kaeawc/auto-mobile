#!/bin/bash
#
# Swift Package Test Script
# Runs tests for all Swift packages that support macOS
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
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IOS_DIR="${PROJECT_ROOT}/ios"

# shellcheck source=scripts/ios/swift_test_counts.sh disable=SC1091
source "${SCRIPT_DIR}/swift_test_counts.sh"

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Swift Package Tests${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Track overall status
OVERALL_STATUS=0
FAILED_PACKAGES=()
SKIPPED_PACKAGES=()
PASSED_PACKAGES=()

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

# Check if swift is available
if ! command -v swift &> /dev/null; then
    echo -e "${RED}Error: swift command not found${NC}"
    exit 1
fi

SWIFT_VERSION=$(swift --version | head -1)
print_info "Swift version: ${SWIFT_VERSION}"
echo ""

# Packages that can be tested on macOS (either macOS-only or cross-platform)
# control-proxy has unit tests that can run on macOS
# XCTestRunner unit tests run on macOS (integration tests are handled by xctestrunner-integration-tests.sh)
TESTABLE_PACKAGES=(
    "auto-mobile-sdk"
    "control-proxy"
    "XCTestRunner"
    "screen-capture"
)

# Total tests executed in a `swift test` transcript.
#
# Both runners can appear in one package's output, so their counts are summed:
#   XCTest        "Executed 26 tests, with 0 failures ..."
#   swift-testing "Test run with 0 tests in 0 suites passed ..."
#
# XCTest prints one "Executed" line per test bundle AND a duplicate summary line,
# so the maximum is taken rather than the sum of the XCTest lines; swift-testing's
# single count is then added.
# Run tests for macOS-compatible packages
echo -e "${BLUE}Running tests for macOS-compatible packages...${NC}"
for package in "${TESTABLE_PACKAGES[@]}"; do
    PACKAGE_DIR="${IOS_DIR}/${package}"
    if [ -f "${PACKAGE_DIR}/Package.swift" ]; then
        echo -e "  Testing ${package}..."

        # Check if the package has test targets
        if grep -q "testTarget" "${PACKAGE_DIR}/Package.swift"; then
            # Assign inside the `if` condition: under set -e a bare
            # test_output="$(failing-cmd)" aborts the whole script, so a package
            # that genuinely fails would kill the run instead of being recorded.
            if test_output="$(cd "${PACKAGE_DIR}" && swift test -Xswiftc -warnings-as-errors 2>&1)"; then
                test_rc=0
            else
                test_rc=$?
            fi
            echo "${test_output}"
            executed_test_count "${test_output}"

            if [ "${test_rc}" -ne 0 ]; then
                print_status 1 "${package} tests failed"
                FAILED_PACKAGES+=("${package}")
            elif [ "${EXECUTED_TESTS}" -eq 0 ]; then
                # `swift test` exits 0 when it runs nothing, so a package whose
                # suite was deleted, emptied, or simply not discovered is
                # indistinguishable from one that passed (issue #4143). A package
                # that declares a testTarget must actually execute tests.
                print_status 1 "${package} declares a testTarget but executed 0 tests"
                FAILED_PACKAGES+=("${package} (0 tests executed)")
            else
                print_status 0 "${package} tests passed"
                PASSED_PACKAGES+=("${package}")
            fi
        else
            print_warning "${package} has no test targets"
            SKIPPED_PACKAGES+=("${package} (no tests)")
        fi
    else
        print_info "Skipping ${package} (no Package.swift)"
        SKIPPED_PACKAGES+=("${package} (no Package.swift)")
    fi
done
echo ""

# Summary
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Test Summary${NC}"
echo -e "${CYAN}========================================${NC}"

if [ ${#PASSED_PACKAGES[@]} -gt 0 ]; then
    echo -e "${GREEN}Passed:${NC}"
    for pkg in "${PASSED_PACKAGES[@]}"; do
        echo -e "  ${GREEN}✓${NC} ${pkg}"
    done
fi

if [ ${#SKIPPED_PACKAGES[@]} -gt 0 ]; then
    echo -e "${YELLOW}Skipped:${NC}"
    for pkg in "${SKIPPED_PACKAGES[@]}"; do
        echo -e "  ${YELLOW}⚠${NC} ${pkg}"
    done
fi

if [ ${#FAILED_PACKAGES[@]} -gt 0 ]; then
    echo -e "${RED}Failed:${NC}"
    for pkg in "${FAILED_PACKAGES[@]}"; do
        echo -e "  ${RED}✗${NC} ${pkg}"
    done
fi

echo ""
if [ $OVERALL_STATUS -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
else
    echo -e "${RED}Some tests failed!${NC}"
fi

exit $OVERALL_STATUS
