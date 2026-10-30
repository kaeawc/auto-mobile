#!/usr/bin/env bash
# iOS SDK contract suite (#5164): builds Playground (Debug) for a booted simulator, then
# runs scripts/ios/sdk-contract/run.ts, which drives the SDK network adapters in Playground
# and follows each event through CtrlProxy, the daemon's iOS client and the MCP network
# resources. A failure names the boundary that disagreed. Needs a running daemon and a
# CtrlProxy on the simulator, as the other simulator-lane integration scripts do.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
device_id="${1:-}"
if [[ ! "${device_id}" =~ ^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$ ]]; then
    echo "Usage: bash scripts/ios/sdk-contract-integration.sh <booted-simulator-udid> [report.json]" >&2
    exit 2
fi
report_path="${2:-${AUTOMOBILE_LOG_DIR:-${repo_root}/scratch}/sdk-contract-report.json}"

derived_data="$(mktemp -d "${TMPDIR:-/tmp}/auto-mobile-sdk-contract.XXXXXX")"
cleanup() {
    find "${derived_data}" -depth -delete
}
trap cleanup EXIT

mkdir -p "$(dirname "${report_path}")"
xcrun simctl bootstatus "${device_id}" -b

# Debug, because the SDK only delivers events to CtrlProxy in DEBUG builds.
xcodebuild \
    -project "${repo_root}/ios/Playground/Playground.xcodeproj" \
    -scheme Playground \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=${device_id}" \
    -derivedDataPath "${derived_data}" \
    build

app_path="${derived_data}/Build/Products/Debug-iphonesimulator/Playground.app"
if [[ ! -d "${app_path}" ]]; then
    echo "error: Playground build produced no app at ${app_path}" >&2
    exit 1
fi

cd "${repo_root}"
bun scripts/ios/sdk-contract/run.ts --device "${device_id}" --app "${app_path}" --report "${report_path}"
