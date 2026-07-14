#!/usr/bin/env bash
#
# Pre-build Reminders XCTest bundle
#
# Compiles the XCTestRunner Swift test bundle BEFORE the target-app warm-up step so
# the timed Reminders plan's `swift test` (run-reminders-launch-plan-tests.sh) starts
# executing almost immediately instead of first spending tens of seconds compiling.
#
# Why this matters (#3851 direction 4): the CI warm-up steps
# (ensure-ctrl-proxy-ready.sh, warm-reminders-target-app.sh) leave CtrlProxy attached
# and Reminders foregrounded so the first timed `observe` is fast. But if `swift test`
# then compiles the XCTest bundle before the timed plan runs, the simulator/app go cold
# again during that compile — undoing the warm-up and reintroducing the cold
# `observe waitFor timed out` failure. Compiling the bundle here, before the final
# warm-up, closes that gap: `swift test` reuses the already-built products.
#
# Must run AFTER the leg's Xcode toolchain is selected (the ios-simulator-bring-up
# composite does this) so the build cache matches the `swift test` that follows; a
# mismatched toolchain would miss the cache and recompile inside the timed step anyway.
#
# Usage:
#   ./scripts/ci/prebuild-reminders-xctest-bundle.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}/ios/XCTestRunner"

echo "Pre-building XCTestRunner test bundle with $(xcodebuild -version 2>/dev/null | head -1 || echo 'selected Xcode')..."
swift build --build-tests
echo "XCTest bundle pre-built; swift test will reuse these products."
