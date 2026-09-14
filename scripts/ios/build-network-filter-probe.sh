#!/usr/bin/env bash
# Build the allow-only attribution milestone. This never installs a filter.
#
# Modes:
#   unsigned          Build a universal (arm64 + x86_64) app bundle; not installable.
#   signed            Build, sign, notarize, and staple the universal bundle.
#   activate [APP]    Run the installed controller's `activate` and map its
#                     JSON state to a distinct exit code (see below). APP
#                     defaults to the /Applications install location.
#
# `activate` exit codes (#6897): the controller itself exits 0 for
# approval_required so shell callers used to see success before the provider
# was ready. This wrapper returns:
#   0  ready
#   3  approval_required — approve the extension/filter in System Settings
#   4  restart_required  — the extension installs after a macOS restart
#   1  any other non-ready state (installation_required, unavailable, timeout)
#   2  usage error
set -euo pipefail

EXIT_USAGE=2
EXIT_APPROVAL_REQUIRED=3
EXIT_RESTART_REQUIRED=4
PROBE_ARCHS="arm64 x86_64"
DEFAULT_APP="/Applications/AutoMobile Network Identity Probe.app"

mode="${1:-unsigned}"
if [[ "${mode}" != unsigned && "${mode}" != signed && "${mode}" != activate ]]; then
  echo "Usage: $0 [unsigned|signed|activate [app-path]]" >&2
  exit "${EXIT_USAGE}"
fi

# --- activate -----------------------------------------------------------------
if [[ "${mode}" == activate ]]; then
  app="${2:-${DEFAULT_APP}}"
  controller="${app}/Contents/MacOS/network-filter-controller"
  if [[ ! -x "${controller}" ]]; then
    echo "Controller executable does not exist: ${controller}" >&2
    exit "${EXIT_USAGE}"
  fi
  set +e
  result="$("${controller}" activate)"
  controller_status=$?
  set -e
  # Forward the controller's JSON verbatim so callers keep the structured detail.
  printf '%s\n' "${result}"
  state="$(jq -r '.state // empty' <<<"${result}" 2>/dev/null || true)"
  detail="$(jq -r '.detail // empty' <<<"${result}" 2>/dev/null || true)"
  if [[ "${state}" == approval_required ]]; then
    # The controller reports a pending restart as approval_required; only the
    # detail distinguishes it (see NetworkFilterController/main.swift).
    if [[ "${detail}" == *restart* ]]; then
      echo "Activation requires a macOS restart before the extension is usable." >&2
      exit "${EXIT_RESTART_REQUIRED}"
    fi
    echo "Activation requires user approval in System Settings; run activate again afterwards." >&2
    exit "${EXIT_APPROVAL_REQUIRED}"
  fi
  if [[ "${state}" == ready && "${controller_status}" -eq 0 ]]; then
    exit 0
  fi
  if [[ "${controller_status}" -ne 0 ]]; then
    exit "${controller_status}"
  fi
  echo "Controller exited 0 without reporting ready (state: ${state:-unknown})." >&2
  exit 1
fi

# --- unsigned / signed ----------------------------------------------------------
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../.." && pwd)"
package_dir="${project_root}/ios/network-filter"
# PLIST_BUDDY and PROBE_OUTPUT_ROOT are test seams; production keeps the defaults
# (the release workflow finds probe-stapled.zip under scratch/).
plist_buddy="${PLIST_BUDDY:-/usr/libexec/PlistBuddy}"
team="${MACOS_DEVELOPER_ID_TEAM_ID:-UNSIGNED00}"
if [[ ! "${team}" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "MACOS_DEVELOPER_ID_TEAM_ID must be a ten-character Apple team identifier" >&2
  exit "${EXIT_USAGE}"
fi
if [[ "${mode}" == signed ]]; then
  : "${MACOS_DEVELOPER_ID_SIGNING_IDENTITY:?A Developer ID Application identity is required}"
  : "${MACOS_DEVELOPER_ID_TEAM_ID:?An Apple team identifier is required}"
  : "${MACOS_PROBE_CONTROLLER_PROFILE:?A containing-app Developer ID provisioning profile is required}"
  : "${MACOS_PROBE_PROVIDER_PROFILE:?A Network Extension Developer ID provisioning profile is required}"
  for profile in "${MACOS_PROBE_CONTROLLER_PROFILE}" "${MACOS_PROBE_PROVIDER_PROFILE}"; do
    if [[ ! -f "${profile}" ]]; then
      echo "Provisioning profile does not exist: ${profile}" >&2
      exit "${EXIT_USAGE}"
    fi
  done
fi

output_root="${PROBE_OUTPUT_ROOT:-${project_root}/scratch}"
mkdir -p "${output_root}"
output="$(mktemp -d "${output_root}/network-filter-probe.XXXXXX")"
slices="${output}/slices"

# Build every slice separately and copy each out before the next build so the
# result does not depend on where SwiftPM places per-arch products (#6897).
# `swift build` alone only produces the runner's own architecture, which fails
# to launch on the opposite Intel/Apple Silicon Mac.
for arch in ${PROBE_ARCHS}; do
  swift build --package-path "${package_dir}" -c release --arch "${arch}" -Xswiftc -warnings-as-errors
  bin_path="$(swift build --package-path "${package_dir}" -c release --arch "${arch}" --show-bin-path)"
  mkdir -p "${slices}/${arch}"
  cp "${bin_path}/network-filter-controller" "${bin_path}/network-filter-provider" "${slices}/${arch}/"
done

# Combine the slices into universal executables and prove every requested
# architecture is present before anything is signed.
mkdir -p "${slices}/universal"
for executable in network-filter-controller network-filter-provider; do
  inputs=()
  for arch in ${PROBE_ARCHS}; do
    inputs+=("${slices}/${arch}/${executable}")
  done
  universal="${slices}/universal/${executable}"
  lipo -create "${inputs[@]}" -output "${universal}"
  archs="$(lipo -archs "${universal}")"
  for arch in ${PROBE_ARCHS}; do
    case " ${archs} " in
      *" ${arch} "*) ;;
      *)
        echo "${executable} is missing the ${arch} slice (lipo -archs: ${archs})" >&2
        exit 1
        ;;
    esac
  done
  echo "${executable}: ${archs}"
done

app="${output}/AutoMobile Network Identity Probe.app"
provider="${app}/Contents/Library/SystemExtensions/dev.jasonpearson.automobile.networkfilter.provider.systemextension"
mkdir -p "${app}/Contents/MacOS" "${provider}/Contents/MacOS"
cp "${slices}/universal/network-filter-controller" "${app}/Contents/MacOS/"
cp "${slices}/universal/network-filter-provider" "${provider}/Contents/MacOS/"
cp "${package_dir}/Packaging/Controller-Info.plist" "${app}/Contents/Info.plist"
cp "${package_dir}/Packaging/Provider-Info.plist" "${provider}/Contents/Info.plist"
cp "${package_dir}/Packaging/Controller.entitlements" "${output}/Controller.entitlements"
cp "${package_dir}/Packaging/Provider.entitlements" "${output}/Provider.entitlements"

group="${team}.dev.jasonpearson.automobile.networkfilter"
service="${group}.provider"
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
