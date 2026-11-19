#!/usr/bin/env bash
#
# Ensure iOS Simulator Runtime
#
# Checks that the iOS simulator runtime matching the current Xcode's SDK
# version is available. If missing, downloads it via xcodebuild.
#
# Usage:
#   ./scripts/ios/ensure-simulator-runtime.sh [--check-only]
#
# Options:
#   --check-only  Only report whether the runtime is present; do not download.
#
# Outputs (stdout):
#   major_minor=<version>       e.g. "26.3" (SDK 26.3 or 26.3.1)
#   needs_download=true|false
#   runtime_count=<N>
#
# Exit codes:
#   0  Runtime is available (or was successfully downloaded)
#   1  Runtime is missing and could not be installed

set -euo pipefail

CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# shellcheck source=scripts/ios/simulator-select.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/simulator-select.sh"

sdk_version=$(xcrun --sdk iphonesimulator --show-sdk-version)
# Major.minor of the SDK: "26.6" and "26.6.1" both need an iOS 26.6 runtime.
# (`${sdk_version%.*}` turned "26.6" into "26", so an unusable 26.5 runtime
# satisfied the check and 26.6 was never downloaded.)
IFS=. read -r sdk_major sdk_minor _ <<< "${sdk_version}"
major_minor="${sdk_major}.${sdk_minor:-0}"
echo "Xcode SDK version: ${sdk_version} (need iOS ${major_minor} runtime)" >&2

# Counts usable runtimes only (available, with a supported architecture, not a
# device-specific runtime such as iOS-27-2-iPhone19-4); see simulator-select.sh.
count_runtimes() {
  local runtimes_json
  runtimes_json=$(xcrun simctl list runtimes iOS --json)
  jq --arg v "$1" "${IOS_SIM_COUNT_MATCHING_RUNTIMES_JQ}" <<< "${runtimes_json}"
}

match_count=$(count_runtimes "${major_minor}")
echo "Found ${match_count} iOS ${major_minor}.x simulator runtime(s)" >&2

# Emit machine-readable output
echo "major_minor=${major_minor}"
echo "runtime_count=${match_count}"

if [[ "${match_count}" -gt 0 ]]; then
  echo "needs_download=false"
  exit 0
fi

echo "needs_download=true"

if [[ "${CHECK_ONLY}" == "true" ]]; then
  echo "::warning::No iOS ${major_minor}.x simulator runtime found" >&2
  exit 1
fi

echo "::warning::No iOS ${major_minor}.x simulator runtime found — downloading platform" >&2
xcodebuild -downloadPlatform iOS

# Verify after download
match_count=$(count_runtimes "${major_minor}")
echo "Found ${match_count} iOS ${major_minor}.x simulator runtime(s) after download" >&2

if [[ "${match_count}" -eq 0 ]]; then
  echo "::error::Still no iOS ${major_minor}.x simulator runtime after download" >&2
  exit 1
fi
