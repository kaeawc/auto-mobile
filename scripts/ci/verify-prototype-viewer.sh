#!/usr/bin/env bash
# Verify a universal, ad-hoc-signed simulator viewer archive before release.
# Usage: verify-prototype-viewer.sh <zip> [expected-min-ios]
# expected-min-ios defaults to $PROTOTYPE_VIEWER_MIN_IOS, then 17.0.
set -euo pipefail

archive="${1:?Usage: verify-prototype-viewer.sh <zip> [expected-min-ios]}"
expected_min="${2:-${PROTOTYPE_VIEWER_MIN_IOS:-17.0}}"
if [[ ! -s "${archive}" ]]; then
  echo "ERROR: prototype viewer not found or empty: ${archive}" >&2
  exit 1
fi
for tool in ditto lipo plutil codesign zipinfo; do
  command -v "${tool}" >/dev/null || { echo "ERROR: ${tool} is required" >&2; exit 1; }
done
# shellcheck source=scripts/lib/lipo-verify-arch.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/lipo-verify-arch.sh"
archive_entries="$(zipinfo -1 "${archive}")"
while IFS= read -r entry; do
  case "${entry}" in
    __MACOSX/*|*/__MACOSX/*|._*|*/._*)
      echo "ERROR: archive must not contain AppleDouble or __MACOSX entries: ${entry}" >&2
      exit 1
      ;;
  esac
done <<<"${archive_entries}"
work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
ditto -x -k "${archive}" "${work_dir}"
shopt -s nullglob dotglob
entries=("${work_dir}"/*)
app="${work_dir}/PrototypeViewer.app"
if [[ ${#entries[@]} -ne 1 || "${entries[0]}" != "${app}" || ! -d "${app}" || -L "${app}" ]]; then
  echo "ERROR: archive must contain exactly one top-level PrototypeViewer.app" >&2
  exit 1
fi
executable="${app}/PrototypeViewer"
if [[ ! -s "${executable}" || ! -x "${executable}" ]]; then
  echo "ERROR: PrototypeViewer executable missing or not executable" >&2
  exit 1
fi
lipo_verify_archs "${executable}" arm64 x86_64
minos="$(plutil -extract MinimumOSVersion raw -o - "${app}/Info.plist")"
if [[ "${minos}" != "${expected_min}" ]]; then
  echo "ERROR: MinimumOSVersion must be ${expected_min}, got '${minos}'" >&2
  exit 1
fi
codesign --verify --strict "${app}"
sign_info="$(codesign -dv "${app}" 2>&1)"
if ! grep '^Signature=adhoc' <<<"${sign_info}" >/dev/null; then
  echo "ERROR: signature must be ad-hoc" >&2
  exit 1
fi
if [[ -n "$(find "${app}" \( -name Assets.car -o -name InfoPlist.strings \) -print -quit)" ]]; then
  echo "ERROR: viewer must not contain Assets.car or InfoPlist.strings" >&2
  exit 1
fi
# Convert the complete plist, including nested icon dictionaries, using the required Apple tool.
plist_xml="$(plutil -convert xml1 -o - "${app}/Info.plist")"
if grep -Fq 'CFBundleIconName' <<<"${plist_xml}"; then
  echo "ERROR: viewer must not contain CFBundleIconName" >&2
  exit 1
fi
echo "Prototype viewer verified: ${archive}"
