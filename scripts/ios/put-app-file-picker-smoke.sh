#!/usr/bin/env bash
# Proves the bounded iOS Files-picker fixture seam selected in #5806.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
device_id="${1:-}"
app_id="dev.jasonpearson.automobile.Playground"
fixture_namespace="automobile-issue-5806"
fixture_name="automobile-files-probe.txt"
fixture_source="${repo_root}/ios/Playground/Fixtures/${fixture_name}"
derived_data="$(mktemp -d "${TMPDIR:-/tmp}/auto-mobile-ios-files-picker.XXXXXX")"

cleanup() {
    find "${derived_data}" -depth -delete
}
trap cleanup EXIT

if [[ -z "${device_id}" ]]; then
    device_id="$(xcrun simctl list devices booted | awk -F '[()]' '/iPhone|iPad/ { print $2; exit }')"
fi

if [[ -z "${device_id}" ]]; then
    echo "No booted iOS Simulator found. Pass its UDID as the first argument." >&2
    exit 1
fi

if [[ ! -f "${fixture_source}" ]]; then
    echo "Missing fixture source: ${fixture_source}" >&2
    exit 1
fi

xcrun simctl bootstatus "${device_id}" -b

xcodebuild \
    -project "${repo_root}/ios/Playground/Playground.xcodeproj" \
    -scheme PlaygroundFilesPickerSmoke \
    -destination "platform=iOS Simulator,id=${device_id}" \
    -derivedDataPath "${derived_data}" \
    build-for-testing

app_path="${derived_data}/Build/Products/Debug-iphonesimulator/Playground.app"
xcrun simctl install "${device_id}" "${app_path}"

data_container="$(xcrun simctl get_app_container "${device_id}" "${app_id}" data)"
documents_root="${data_container}/Documents"
fixture_root="${documents_root}/${fixture_namespace}"

if [[ "${fixture_root}" != "${documents_root}/${fixture_namespace}" ]]; then
    echo "Refusing to reset a path outside the declared fixture namespace." >&2
    exit 1
fi

# The reset target is one fixed child of the managed fixture app's Documents
# directory; it never reaches the simulator's Files-provider implementation.
if [[ -e "${fixture_root}" ]]; then
    find "${fixture_root}" -depth -delete
fi
mkdir -p "${fixture_root}"
cp "${fixture_source}" "${fixture_root}/${fixture_name}"

# Launching after staging gives the managed app a chance to observe its Documents
# directory before the real document-picker test starts.
xcrun simctl launch "${device_id}" "${app_id}" >/dev/null
xcrun simctl terminate "${device_id}" "${app_id}"

xcodebuild \
    -project "${repo_root}/ios/Playground/Playground.xcodeproj" \
    -scheme PlaygroundFilesPickerSmoke \
    -destination "platform=iOS Simulator,id=${device_id}" \
    -derivedDataPath "${derived_data}" \
    -only-testing:PlaygroundFilesPickerUITests \
    test-without-building

echo "iOS Files picker smoke passed for ${device_id}"
