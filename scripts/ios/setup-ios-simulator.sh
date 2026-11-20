#!/bin/bash
#
# iOS Simulator Setup Script
# Ensures an iOS Simulator runtime is available for the selected Xcode: the
# repository pin (scripts/ios/xcode_version.sh) when installed, else DEVELOPER_DIR
# or the active Xcode. It prefers the general runtime matching that Xcode's SDK
# and never a device-specific one (see scripts/ios/simulator-select.sh).
#
# This script is designed for CI environments (GitHub Actions) where:
# - Xcode is pre-installed but simulator runtimes may be missing or mismatched
# - The runner may have different simulator runtimes than what Xcode expects
# - Downloads may be required to get a compatible runtime
#
# Usage:
#   ./setup-ios-simulator.sh [options]
#
# Options:
#   --dry-run          Show what would be done without making changes
#   --force-download   Force download even if a runtime is available
#   --skip-download    Don't download missing runtimes, just report status
#   --verbose          Show detailed output
#   --min-ios VERSION  Minimum iOS version required (default: from project)
#
# Environment Variables:
#   IOS_SIMULATOR_DESTINATION  Set to override the auto-detected destination
#

set -euo pipefail

# Options
DRY_RUN=false
FORCE_DOWNLOAD=false
SKIP_DOWNLOAD=false
VERBOSE=false
MIN_IOS_VERSION=""

# A `while … shift` loop (not `for arg in "$@"`) so `--min-ios VERSION` (the
# space-separated form documented in the help) is honored, not just
# `--min-ios=VERSION`. The old for-loop dropped the space form silently (#3645).
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force-download)
            FORCE_DOWNLOAD=true
            shift
            ;;
        --skip-download)
            SKIP_DOWNLOAD=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --min-ios=*)
            MIN_IOS_VERSION="${1#*=}"
            shift
            ;;
        --min-ios)
            MIN_IOS_VERSION="${2:?--min-ios requires a VERSION argument}"
            shift 2
            ;;
        *)
            shift
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

log_info() {
    echo -e "${BLUE}ℹ${NC} $1" >&2
}

log_success() {
    echo -e "${GREEN}✓${NC} $1" >&2
}

log_warn() {
    echo -e "${YELLOW}⚠${NC} $1" >&2
}

log_error() {
    echo -e "${RED}✗${NC} $1" >&2
}

log_debug() {
    if [ "$VERBOSE" = true ]; then
        echo -e "${CYAN}→${NC} $1" >&2
    fi
}

run_cmd() {
    if [ "$DRY_RUN" = true ]; then
        echo -e "  ${YELLOW}↳${NC} (dry-run) $*" >&2
        return 0
    fi
    "$@"
}

echo -e "${CYAN}========================================${NC}" >&2
echo -e "${CYAN}  iOS Simulator Setup${NC}" >&2
echo -e "${CYAN}========================================${NC}" >&2
echo "" >&2

# Check required tools
if ! command -v rg &> /dev/null; then
    log_error "ripgrep (rg) not found. Install with: brew install ripgrep"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    log_error "jq not found. Install with: brew install jq"
    exit 1
fi

if ! command -v xcodebuild &> /dev/null; then
    log_error "xcodebuild not found. Please install Xcode."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/simulator-select.sh
source "${SCRIPT_DIR}/simulator-select.sh"
# Use the repository-pinned Xcode (scripts/ios/xcode_version.sh) unless DEVELOPER_DIR
# already names one, so a host whose xcode-select still points at an older Xcode
# needs no machine-wide switch.
# shellcheck source=scripts/ios/xcode_version.sh
source "${SCRIPT_DIR}/xcode_version.sh"
select_pinned_xcode

# Get Xcode version info
XCODE_VERSION_FULL=$(xcodebuild -version)
# Split with parameter expansion, not `echo | head -1`: bash line-buffers the
# builtin echo, so a multi-line value is written one line at a time and an early
# exiting `head` can SIGPIPE the writer, which pipefail turns into exit 141
# (#17131). For the same reason, pipes below read with `sed -n` (which drains
# its input) rather than `head`.
XCODE_VERSION_LINE="${XCODE_VERSION_FULL%%$'\n'*}"
XCODE_VERSION="${XCODE_VERSION_LINE#Xcode }"
XCODE_BUILD_LINE="${XCODE_VERSION_FULL##*$'\n'}"
XCODE_BUILD="${XCODE_BUILD_LINE#Build version }"
XCODE_PATH="${DEVELOPER_DIR:-$(xcode-select -p)}"

log_info "Xcode version: ${XCODE_VERSION} (${XCODE_BUILD})"
log_info "Xcode path: ${XCODE_PATH}"

# Detect the iOS Simulator SDK version bundled with this Xcode.
# This tells us the maximum iOS runtime version this Xcode can use.
# On CI runners with multiple Xcode versions, runtimes from newer Xcode
# installations are visible but unusable by older Xcode versions.
MAX_IOS_SDK_VERSION=$(xcodebuild -showsdks 2>/dev/null | sed -n 's/.*-sdk iphonesimulator\([0-9.]*\)/\1/p' | sort -V | tail -1)
if [ -n "$MAX_IOS_SDK_VERSION" ]; then
    log_info "iOS Simulator SDK: ${MAX_IOS_SDK_VERSION} (max runtime version)"
else
    log_error "Could not detect iOS Simulator SDK version (no iphonesimulator SDK found)"
    log_error "Ensure Xcode is installed with iOS Simulator support"
    exit 1
fi
echo "" >&2

# Script directory for finding project files
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IOS_DIR="${PROJECT_ROOT}/ios"

# Detect minimum iOS version from project files if not specified
detect_min_ios_version() {
    local min_version="17.0"  # Default fallback

    # Use ripgrep to find all iOS deployment targets in one pass
    # Pattern matches: iOS: "16.0" or iOS: 16.0
    local versions
    versions=$(rg -o --no-filename 'iOS:\s*"?([0-9.]+)"?' -r '$1' "${IOS_DIR}"/*/project.yml 2>/dev/null || echo "")
    if [ -n "$versions" ]; then
        # Get the highest version found
        min_version=$(echo "$versions" | sort -V | tail -1)
        log_debug "Found deployment targets via ripgrep, highest: ${min_version}"
    fi

    echo "$min_version"
}

if [ -z "$MIN_IOS_VERSION" ]; then
    MIN_IOS_VERSION=$(detect_min_ios_version)
fi
log_info "Minimum iOS deployment target: ${MIN_IOS_VERSION}"

# Runtime and simulator selection reads `simctl --json` through the shared jq
# programs in simulator-select.sh, so it skips what text parsing could not tell
# apart: a device-specific runtime such as iOS-27-2-iPhone19-4 (iPhone Duo only,
# listed as "iOS 27.2" next to the general iOS-27-2), a Duo-only runtime such as
# iOS-27-1, an unavailable runtime and one newer than this Xcode's SDK (#18812).
IFS=. read -r sdk_major sdk_minor _ <<< "${MAX_IOS_SDK_VERSION}"
SDK_MAJOR_MINOR="${sdk_major}.${sdk_minor:-0}"

BEST_IOS_VERSION=""
BEST_RUNTIME_ID=""
SIMULATOR_DEVICE=""
SIMULATOR_UDID=""

# Sets BEST_IOS_VERSION / BEST_RUNTIME_ID to the newest usable runtime matching
# the SDK (else the newest usable one in [MIN_IOS_VERSION, SDK]), and
# SIMULATOR_UDID / SIMULATOR_DEVICE to an available iPhone on that runtime.
select_runtime_and_simulator() {
    local runtimes_json devices_json pick
    runtimes_json=$(xcrun simctl list runtimes iOS --json 2>/dev/null) || runtimes_json=""
    [[ -n "${runtimes_json}" ]] || runtimes_json='{"runtimes":[]}'

    echo -e "${BLUE}Available iOS Simulator Runtimes:${NC}" >&2
    jq -r '.runtimes[]? | "  \(.name) - \(.identifier)"' <<< "${runtimes_json}" >&2 2>/dev/null \
        || log_warn "Could not parse simctl runtimes"

    pick=$(jq -r --arg v "${SDK_MAJOR_MINOR}" --arg min "${MIN_IOS_VERSION}" \
        "${IOS_SIM_PICK_RUNTIME_JQ}" <<< "${runtimes_json}" 2>/dev/null) || pick=""
    BEST_IOS_VERSION=""
    BEST_RUNTIME_ID=""
    SIMULATOR_DEVICE=""
    SIMULATOR_UDID=""
    if [[ -z "${pick}" ]]; then
        return 0
    fi
    BEST_IOS_VERSION="${pick%%$'\t'*}"
    BEST_RUNTIME_ID="${pick#*$'\t'}"

    devices_json=$(xcrun simctl list devices --json 2>/dev/null) || devices_json=""
    [[ -n "${devices_json}" ]] || devices_json='{"devices":{}}'
    # min = v = the chosen version: a booted iPhone on that version's general
    # runtime wins, else any available iPhone on the chosen runtime.
    pick=$(jq -r --argjson runtimes "${runtimes_json}" --arg v "${BEST_IOS_VERSION}" \
        --arg min "${BEST_IOS_VERSION}" --arg runtime "${BEST_RUNTIME_ID}" \
        "${IOS_SIM_PICK_SIMULATOR_JQ}" <<< "${devices_json}" 2>/dev/null) || pick=""
    if [[ -n "${pick}" ]]; then
        SIMULATOR_UDID="${pick%%$'\t'*}"
        SIMULATOR_DEVICE="${pick#*$'\t'}"
    else
        log_debug "No available iPhone simulator on ${BEST_RUNTIME_ID}"
    fi
}

select_runtime_and_simulator

if [ -n "$BEST_IOS_VERSION" ]; then
    log_success "Found compatible iOS runtime: iOS ${BEST_IOS_VERSION} (${BEST_RUNTIME_ID})"
else
    log_warn "No compatible iOS runtime found (need >= ${MIN_IOS_VERSION}, <= ${SDK_MAJOR_MINOR})"
fi
echo "" >&2

# Build the destination string. A UDID is unambiguous where a name + OS pair is
# not (the general and the Duo-only runtime both report OS 27.2).
build_destination() {
    local ios_version=$1
    local udid=$2

    if [ -n "$udid" ]; then
        echo "platform=iOS Simulator,id=${udid}"
    elif [ -n "$ios_version" ]; then
        echo "platform=iOS Simulator,OS=${ios_version}"
    else
        echo "generic/platform=iOS Simulator"
    fi
}

# Check if we need to download
NEEDS_DOWNLOAD=false

if [ -z "$BEST_IOS_VERSION" ]; then
    NEEDS_DOWNLOAD=true
fi

if [ "$FORCE_DOWNLOAD" = true ]; then
    log_info "Force download flag set"
    NEEDS_DOWNLOAD=true
fi

# Handle download if needed
if [ "$NEEDS_DOWNLOAD" = true ]; then
    if [ "$SKIP_DOWNLOAD" = true ]; then
        log_warn "Download skipped (--skip-download flag)"
        log_error "No compatible iOS Simulator runtime available"
        exit 1
    fi

    echo "" >&2
    log_info "Downloading iOS platform for Xcode ${XCODE_VERSION}..."
    log_info "This may take several minutes..."
    echo "" >&2

    DOWNLOAD_START=$(date +%s)

    if [ "$DRY_RUN" = true ]; then
        run_cmd xcodebuild -downloadPlatform iOS
        DOWNLOAD_EXIT_CODE=0
    else
        set +e
        xcodebuild -downloadPlatform iOS 2>&1 | while IFS= read -r line; do
            if [ "$VERBOSE" = true ]; then
                echo "  $line" >&2
            else
                if grep -qE "Downloading|Installing|Progress|%" <<<"${line}"; then
                    printf "\r  %s" "$line" >&2
                fi
            fi
        done
        DOWNLOAD_EXIT_CODE=${PIPESTATUS[0]}
        set -e
        echo "" >&2
    fi

    DOWNLOAD_END=$(date +%s)
    DOWNLOAD_DURATION=$((DOWNLOAD_END - DOWNLOAD_START))

    if [ "$DOWNLOAD_EXIT_CODE" -ne 0 ]; then
        log_error "Failed to download iOS platform (exit code: ${DOWNLOAD_EXIT_CODE})"
        exit 1
    fi

    log_success "Download completed in ${DOWNLOAD_DURATION}s"
    echo "" >&2

    # Refresh runtime list
    sleep 2
    select_runtime_and_simulator
fi

# Final destination
DESTINATION=$(build_destination "$BEST_IOS_VERSION" "$SIMULATOR_UDID")

# Export for use by other scripts
export IOS_SIMULATOR_RUNTIME="$BEST_IOS_VERSION"
export IOS_SIMULATOR_RUNTIME_ID="$BEST_RUNTIME_ID"
export IOS_SIMULATOR_DEVICE="$SIMULATOR_DEVICE"
export IOS_SIMULATOR_UDID="$SIMULATOR_UDID"
export IOS_SIMULATOR_DESTINATION="$DESTINATION"

# Write to GitHub Actions output if available
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
        echo "ios-runtime=${BEST_IOS_VERSION}"
        echo "ios-runtime-id=${BEST_RUNTIME_ID}"
        echo "ios-device=${SIMULATOR_DEVICE}"
        echo "ios-udid=${SIMULATOR_UDID}"
        echo "ios-destination=${DESTINATION}"
    } >> "$GITHUB_OUTPUT"
fi

# Also write to a file for non-GitHub environments
DEST_FILE="${PROJECT_ROOT}/.ios-simulator-destination"
if [ "$DRY_RUN" = false ]; then
    cat > "$DEST_FILE" << EOF
# Auto-generated by setup-ios-simulator.sh
# Source this file or read these values for xcodebuild commands
IOS_SIMULATOR_RUNTIME="${BEST_IOS_VERSION}"
IOS_SIMULATOR_RUNTIME_ID="${BEST_RUNTIME_ID}"
IOS_SIMULATOR_DEVICE="${SIMULATOR_DEVICE}"
IOS_SIMULATOR_UDID="${SIMULATOR_UDID}"
IOS_SIMULATOR_DESTINATION="${DESTINATION}"
EOF
    log_debug "Wrote destination config to ${DEST_FILE}"
fi

# Summary
echo "" >&2
echo -e "${CYAN}========================================${NC}" >&2
echo -e "${CYAN}  Setup Complete${NC}" >&2
echo -e "${CYAN}========================================${NC}" >&2
echo "" >&2
echo "  Xcode version:     ${XCODE_VERSION}" >&2
echo "  Min iOS target:    ${MIN_IOS_VERSION}" >&2
echo "  iOS runtime:       ${BEST_IOS_VERSION:-none} ${BEST_RUNTIME_ID}" >&2
echo "  Simulator device:  ${SIMULATOR_DEVICE:-auto}" >&2
echo "  Destination:       ${DESTINATION}" >&2
echo "" >&2

if [ -n "$BEST_IOS_VERSION" ]; then
    log_success "iOS Simulator ready"
    echo "" >&2
    echo -e "${BLUE}Use this destination in xcodebuild:${NC}" >&2
    echo "  -destination '${DESTINATION}'" >&2
    exit 0
else
    log_error "No compatible iOS Simulator runtime available"
    exit 1
fi
