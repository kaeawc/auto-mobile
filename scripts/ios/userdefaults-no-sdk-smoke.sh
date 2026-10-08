#!/usr/bin/env bash
# Builds a disposable app without the SDK and checks simulator preference writes.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
device_id="${1:-}"
if [[ $# -ne 1 || -z "${device_id}" ]]; then
    echo "Usage: bash scripts/ios/userdefaults-no-sdk-smoke.sh <booted-simulator-udid>" >&2
    exit 2
fi

mkdir -p "${repo_root}/scratch"
build_dir="$(mktemp -d "${repo_root}/scratch/userdefaults-no-sdk.XXXXXX")"
cleanup() {
    rm -rf "${build_dir}"
}
trap cleanup EXIT

app_path="${build_dir}/Probe.app"
mkdir -p "${app_path}"
cp "${repo_root}/ios/UserDefaultsProbe/Info.plist" "${app_path}/Info.plist"
simulator_sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
SDKROOT="${simulator_sdk}" xcrun --sdk iphonesimulator swiftc \
    -sdk "${simulator_sdk}" \
    -target "$(uname -m)-apple-ios17.0-simulator" \
    -parse-as-library "${repo_root}/ios/UserDefaultsProbe/Probe.swift" \
    -o "${app_path}/Probe"
codesign --force --sign - "${app_path}"

cd "${repo_root}"
export AUTOMOBILE_DATA_DIR="${build_dir}/data"
export AUTOMOBILE_LOG_DIR="${build_dir}/logs"
bun scripts/ios/userdefaults-no-sdk-smoke.ts "${device_id}" "${app_path}"
