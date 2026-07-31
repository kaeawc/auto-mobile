#!/bin/bash
#
# Add the CtrlProxy display name and launcher icon to Xcode's generated UI-test
# runner. Xcode recreates CtrlProxyUITests-Runner.app on every build, so this
# must run after build-for-testing and before test-without-building installs it.

set -euo pipefail

usage() {
    echo "Usage: $0 --derived-data <path>" >&2
}

DERIVED_DATA=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --derived-data)
            DERIVED_DATA="${2:-}"
            shift 2
            ;;
        *)
            usage
            exit 1
            ;;
    esac
done

if [[ -z "${DERIVED_DATA}" ]]; then
    usage
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ASSET_CATALOG="${PROJECT_ROOT}/ios/control-proxy/CtrlProxyApp/Assets.xcassets"
SIMULATOR_PRODUCTS="${DERIVED_DATA}/Build/Products/Debug-iphonesimulator"
RUNNER_APP="${SIMULATOR_PRODUCTS}/CtrlProxyUITests-Runner.app"
RUNNER_INFO_PLIST="${RUNNER_APP}/Info.plist"
PLIST_BUDDY="${PLIST_BUDDY:-/usr/libexec/PlistBuddy}"
PLUTIL="${PLUTIL:-plutil}"

if [[ ! -d "${RUNNER_APP}" || ! -f "${RUNNER_INFO_PLIST}" ]]; then
    echo "CtrlProxy UI-test runner not found: ${RUNNER_APP}" >&2
    exit 1
fi

if [[ ! -d "${ASSET_CATALOG}" ]]; then
    echo "CtrlProxy asset catalog not found: ${ASSET_CATALOG}" >&2
    exit 1
fi

if [[ ! -x "${PLIST_BUDDY}" ]]; then
    echo "PlistBuddy not found: ${PLIST_BUDDY}" >&2
    exit 1
fi

if ! command -v "${PLUTIL}" >/dev/null 2>&1; then
    echo "plutil not found: ${PLUTIL}" >&2
    exit 1
fi

PATCH_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "${PATCH_DIRECTORY}"' EXIT

xcrun actool \
    --compile "${PATCH_DIRECTORY}" \
    --platform iphonesimulator \
    --minimum-deployment-target 15.0 \
    --app-icon AppIcon \
    --output-partial-info-plist "${PATCH_DIRECTORY}/icon-info.plist" \
    "${ASSET_CATALOG}" >/dev/null

for icon_artifact in Assets.car AppIcon60x60@2x.png AppIcon76x76@2x~ipad.png; do
    if [[ ! -f "${PATCH_DIRECTORY}/${icon_artifact}" ]]; then
        echo "actool did not produce ${icon_artifact}" >&2
        exit 1
    fi
    cp "${PATCH_DIRECTORY}/${icon_artifact}" "${RUNNER_APP}/${icon_artifact}"
done

"${PLIST_BUDDY}" -c "Merge ${PATCH_DIRECTORY}/icon-info.plist :" "${RUNNER_INFO_PLIST}"
"${PLUTIL}" -replace CFBundleDisplayName -string CtrlProxy "${RUNNER_INFO_PLIST}"
"${PLUTIL}" -replace CFBundleName -string CtrlProxy "${RUNNER_INFO_PLIST}"

# The simulator accepts an ad-hoc signature, while a stale signature rejects
# the copied asset catalog during installation.
codesign --force --sign - "${RUNNER_APP}" >/dev/null

echo "Patched CtrlProxyUITests-Runner with the CtrlProxy app icon."
