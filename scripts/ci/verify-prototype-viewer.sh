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
for tool in ditto lipo plutil codesign python3; do
  command -v "${tool}" >/dev/null || { echo "ERROR: ${tool} is required" >&2; exit 1; }
done
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
lipo -verify_arch arm64 x86_64 "${executable}"
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
# Parse the complete plist, including nested icon dictionaries, with stdlib only.
plutil -convert xml1 -o "${work_dir}/Info.plist" "${app}/Info.plist"
python3 - "${work_dir}/Info.plist" <<'PY'
import plistlib
import sys

def has_icon_name(value):
    if isinstance(value, dict):
        return "CFBundleIconName" in value or any(has_icon_name(v) for v in value.values())
    if isinstance(value, list):
        return any(has_icon_name(v) for v in value)
    return False

with open(sys.argv[1], "rb") as file:
    if has_icon_name(plistlib.load(file)):
        sys.exit("ERROR: viewer must not contain CFBundleIconName")
PY
echo "Prototype viewer verified: ${archive}"
