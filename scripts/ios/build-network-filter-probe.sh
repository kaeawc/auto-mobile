#!/usr/bin/env bash
# Build the allow-only attribution milestone. This never installs a filter.
set -euo pipefail

mode="${1:-unsigned}"
if [[ "${mode}" != unsigned && "${mode}" != signed ]]; then
  echo "Usage: $0 [unsigned|signed]" >&2
  exit 2
fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../.." && pwd)"
package_dir="${project_root}/ios/network-filter"
team="${MACOS_DEVELOPER_ID_TEAM_ID:-UNSIGNED00}"
if [[ ! "${team}" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "MACOS_DEVELOPER_ID_TEAM_ID must be a ten-character Apple team identifier" >&2
  exit 2
fi
if [[ "${mode}" == signed ]]; then
  : "${MACOS_DEVELOPER_ID_SIGNING_IDENTITY:?A Developer ID Application identity is required}"
  : "${MACOS_DEVELOPER_ID_TEAM_ID:?An Apple team identifier is required}"
  : "${MACOS_PROBE_CONTROLLER_PROFILE:?A containing-app Developer ID provisioning profile is required}"
  : "${MACOS_PROBE_PROVIDER_PROFILE:?A Network Extension Developer ID provisioning profile is required}"
  for profile in "${MACOS_PROBE_CONTROLLER_PROFILE}" "${MACOS_PROBE_PROVIDER_PROFILE}"; do
    if [[ ! -f "${profile}" ]]; then
      echo "Provisioning profile does not exist: ${profile}" >&2
      exit 2
    fi
  done
fi

swift build --package-path "${package_dir}" -c release -Xswiftc -warnings-as-errors
bin_path="$(swift build --package-path "${package_dir}" -c release --show-bin-path)"
mkdir -p "${project_root}/scratch"
output="$(mktemp -d "${project_root}/scratch/network-filter-probe.XXXXXX")"
app="${output}/AutoMobile Network Identity Probe.app"
provider="${app}/Contents/Library/SystemExtensions/dev.jasonpearson.automobile.networkfilter.provider.systemextension"
mkdir -p "${app}/Contents/MacOS" "${provider}/Contents/MacOS"
cp "${bin_path}/network-filter-controller" "${app}/Contents/MacOS/"
cp "${bin_path}/network-filter-provider" "${provider}/Contents/MacOS/"
cp "${package_dir}/Packaging/Controller-Info.plist" "${app}/Contents/Info.plist"
cp "${package_dir}/Packaging/Provider-Info.plist" "${provider}/Contents/Info.plist"
cp "${package_dir}/Packaging/Controller.entitlements" "${output}/Controller.entitlements"
cp "${package_dir}/Packaging/Provider.entitlements" "${output}/Provider.entitlements"

group="${team}.dev.jasonpearson.automobile.networkfilter"
service="${group}.provider"
plist_buddy=/usr/libexec/PlistBuddy
"${plist_buddy}" -c "Set :ProbeMachServiceName ${service}" "${app}/Contents/Info.plist"
"${plist_buddy}" -c "Set :NetworkExtension:NEMachServiceName ${service}" "${provider}/Contents/Info.plist"
for component in Controller Provider; do
  entitlements="${output}/${component}.entitlements"
  "${plist_buddy}" -c "Set :com.apple.security.application-groups:0 ${group}" "${entitlements}"
  "${plist_buddy}" -c "Set :com.apple.developer.team-identifier ${team}" "${entitlements}"
  identifier="${group}"
  if [[ "${component}" == Provider ]]; then identifier="${group}.provider"; fi
  "${plist_buddy}" -c "Set :com.apple.application-identifier ${identifier}" "${entitlements}"
done

if [[ "${mode}" == signed ]]; then
  cp "${MACOS_PROBE_CONTROLLER_PROFILE}" "${app}/Contents/embedded.provisionprofile"
  cp "${MACOS_PROBE_PROVIDER_PROFILE}" "${provider}/Contents/embedded.provisionprofile"
  # Match the existing macOS signing seam: hardened runtime, secure timestamp,
  # optional build keychain, inside-out signing, and strict verification.
  sign_args=(--force --options runtime --timestamp --sign "${MACOS_DEVELOPER_ID_SIGNING_IDENTITY}")
  if [[ -n "${MACOS_KEYCHAIN_PATH:-}" ]]; then sign_args+=(--keychain "${MACOS_KEYCHAIN_PATH}"); fi
  codesign "${sign_args[@]}" --entitlements "${output}/Provider.entitlements" "${provider}"
  codesign "${sign_args[@]}" --entitlements "${output}/Controller.entitlements" "${app}"
  codesign --verify --strict --verbose=2 "${provider}"
  codesign --verify --strict --verbose=2 "${app}"
  ditto -c -k --keepParent "${app}" "${output}/probe.zip"
  bash "${project_root}/scripts/ci/notarize-macos-artifact.sh" "${output}/probe.zip"
  xcrun stapler staple "${app}"
  ditto -c -k --keepParent "${app}" "${output}/probe-stapled.zip"
else
  echo "Unsigned build only: not installable, provider behavior unverified."
fi
echo "${app}"
