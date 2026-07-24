#!/usr/bin/env bash
# Build, sign, and notarize the universal macOS ScreenCaptureKit helper.

set -euo pipefail

output_path="${1:?Usage: $0 <output-zip-path>}"

: "${MACOS_DEVELOPER_ID_SIGNING_IDENTITY:?MACOS_DEVELOPER_ID_SIGNING_IDENTITY is required}"
: "${APPLE_NOTARY_KEY_ID:?APPLE_NOTARY_KEY_ID is required}"
: "${APPLE_NOTARY_ISSUER_ID:?APPLE_NOTARY_ISSUER_ID is required}"
: "${APPLE_NOTARY_KEY_PATH:?APPLE_NOTARY_KEY_PATH is required}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../.." && pwd)"
package_dir="${project_root}/ios/screen-capture"
archive_path="${output_path}.partial"

rm -f "${archive_path}"

build_args=(
  build
  -c release
  --product screen-capture-helper
  --arch arm64
  --arch x86_64
)

(
  cd "${package_dir}"
  swift "${build_args[@]}"
)

bin_path="$(
  cd "${package_dir}"
  swift "${build_args[@]}" --show-bin-path
)"
helper_path="${bin_path}/screen-capture-helper"

if [[ ! -f "${helper_path}" ]]; then
  echo "screen-capture-helper not found at ${helper_path}" >&2
  exit 1
fi

architectures="$(lipo -archs "${helper_path}")"
for architecture in arm64 x86_64; do
  if [[ " ${architectures} " != *" ${architecture} "* ]]; then
    echo "screen-capture-helper is missing ${architecture}: ${architectures}" >&2
    exit 1
  fi
done

codesign_args=(
  --force
  --options runtime
  --timestamp
  --sign "${MACOS_DEVELOPER_ID_SIGNING_IDENTITY}"
)
if [[ -n "${MACOS_KEYCHAIN_PATH:-}" ]]; then
  codesign_args+=(--keychain "${MACOS_KEYCHAIN_PATH}")
fi
codesign "${codesign_args[@]}" "${helper_path}"
codesign --verify --strict --verbose=2 "${helper_path}"

mkdir -p "$(dirname "${output_path}")"
(
  cd "${bin_path}"
  ditto -c -k --keepParent "screen-capture-helper" "${archive_path}"
)

xcrun notarytool submit "${archive_path}" \
  --key "${APPLE_NOTARY_KEY_PATH}" \
  --key-id "${APPLE_NOTARY_KEY_ID}" \
  --issuer "${APPLE_NOTARY_ISSUER_ID}" \
  --wait

mv "${archive_path}" "${output_path}"
