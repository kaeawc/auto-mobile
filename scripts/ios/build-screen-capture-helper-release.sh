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
output_dir="$(dirname "${output_path}")"
mkdir -p "${output_dir}"
output_path="$(cd "${output_dir}" && pwd -P)/$(basename "${output_path}")"
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

(
  cd "${bin_path}"
  ditto -c -k --keepParent "screen-capture-helper" "${archive_path}"
)

# `notarytool submit --wait` exits 0 even when Apple's verdict is Invalid, so
# parsing the JSON result is the only way to catch a rejection: the helper zip
# is never stapled, so nothing downstream would notice an unnotarized binary.
# Anything but Accepted fails the script, after dumping the notary log so the
# per-file rejection reasons land in the output.
submission_json="$(
  xcrun notarytool submit "${archive_path}" \
    --key "${APPLE_NOTARY_KEY_PATH}" \
    --key-id "${APPLE_NOTARY_KEY_ID}" \
    --issuer "${APPLE_NOTARY_ISSUER_ID}" \
    --wait \
    --output-format json
)"
echo "${submission_json}"
submission_id="$(jq -r '.id // empty' <<<"${submission_json}")"
status="$(jq -r '.status // empty' <<<"${submission_json}")"
if [[ "${status}" != "Accepted" ]]; then
  echo "Notarization verdict: ${status:-unknown} (submission ${submission_id:-unknown})" >&2
  if [[ -n "${submission_id}" ]]; then
    # Best-effort: the log service can lag right after the verdict.
    xcrun notarytool log "${submission_id}" \
      --key "${APPLE_NOTARY_KEY_PATH}" \
      --key-id "${APPLE_NOTARY_KEY_ID}" \
      --issuer "${APPLE_NOTARY_ISSUER_ID}" >&2 || true
  fi
  exit 1
fi

mv "${archive_path}" "${output_path}"
