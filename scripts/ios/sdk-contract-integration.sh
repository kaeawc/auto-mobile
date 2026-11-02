#!/usr/bin/env bash
# iOS SDK contract suite (#5164): builds Playground (Debug) for a booted simulator, then
# runs scripts/ios/sdk-contract/run.ts, which drives the SDK network adapters in Playground
# and follows each event through CtrlProxy, the daemon's iOS client and the MCP network
# resources. A failure names the boundary that disagreed. First build the runner with
# bash scripts/ios/ctrl-proxy-build-for-testing.sh using AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA.
# Start the private daemon with that same path and either AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true
# or AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true plus AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256
# pinned to the checkout xctest executable and AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET=xctest.
# Then run this suite; the daemon reads runner selection at startup, so do not rebuild afterward.

set -euo pipefail

if [[ -z "${AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA:-}" ]] ||
    [[ "${AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD:-}" != true && ! (
        "${AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD:-}" == true &&
        "${AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256:-}" =~ ^[0-9A-Fa-f]{64}$ &&
        "${AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET:-}" == xctest
    ) ]]; then
    echo 'error: requires nonempty AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA and either local build (AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true) or a pinned checkout runner (AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true, AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256=64-hex SHA, AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET=xctest).' >&2
    echo 'Source the private daemon env: source "<batch-dir>/daemon1/env.sh"; ensure it exports the selected configuration, and start the private daemon with that env before running this suite.' >&2
    exit 2
fi

runner_app="${AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA}/Build/Products/Debug-iphonesimulator/AutoMobileTest.app"
if [[ ! -d "${runner_app}" ]]; then
    echo "error: missing prebuilt CtrlProxy runner at ${runner_app}" >&2
    echo 'Build the runner with bash scripts/ios/ctrl-proxy-build-for-testing.sh using the same AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA, then start the private daemon with the local-build env, then rerun this suite.' >&2
    exit 2
fi

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
