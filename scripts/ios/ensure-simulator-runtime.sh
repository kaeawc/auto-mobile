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
#   major_minor=<version>       e.g. "26.3"
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

sdk_version=$(xcrun --sdk iphonesimulator --show-sdk-version)
major_minor="${sdk_version%.*}"
echo "Xcode SDK version: ${sdk_version} (need iOS ${major_minor} runtime)" >&2

count_runtimes() {
  xcrun simctl list runtimes iOS --json \
    | jq --arg v "$1" '[.runtimes[] | select(.version | startswith($v + "."))] | length'
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
