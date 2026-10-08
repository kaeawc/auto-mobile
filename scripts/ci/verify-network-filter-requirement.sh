#!/usr/bin/env bash
# Release guard for the committed MDM profile (#10595).
#
# Usage: verify-network-filter-requirement.sh <path/to/AutoMobile Network Identity Probe.app>
#
# The profile at docs/assets/mdm/automobile-network-filter.mobileconfig
# pre-approves the filter by designated requirement. This script reads that
# requirement back out of the committed profile and checks the signed app
# against it with `codesign --verify --deep --strict -R=...`, so a release whose
# signature would stop matching the profile fails instead of shipping:
#   - the nested system extension must satisfy the profile's
#     FilterDataProviderDesignatedRequirement verbatim;
#   - the containing app must satisfy the same requirement with its own
#     bundle identifier (the profile's PluginBundleID).
#
# PLUTIL, CODESIGN and NETWORK_FILTER_MDM_PROFILE are test seams.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <network-filter-app-path>" >&2
  exit 2
fi
app="$1"
if [[ ! -d "${app}" ]]; then
  echo "Network filter app does not exist: ${app}" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../.." && pwd)"
profile="${NETWORK_FILTER_MDM_PROFILE:-${project_root}/docs/assets/mdm/automobile-network-filter.mobileconfig}"
plutil="${PLUTIL:-plutil}"
codesign="${CODESIGN:-codesign}"

if [[ ! -f "${profile}" ]]; then
  echo "MDM profile does not exist: ${profile}" >&2
  exit 2
fi

# Index 1 is the com.apple.webcontent-filter payload; confirm it rather than
# trusting the position.
extract() {
  "${plutil}" -extract "PayloadContent.1.$1" raw -o - "${profile}"
}
payload_type="$(extract PayloadType)"
if [[ "${payload_type}" != com.apple.webcontent-filter ]]; then
  echo "Expected PayloadContent.1 to be com.apple.webcontent-filter, found: ${payload_type}" >&2
  exit 1
fi
extension_id="$(extract FilterDataProviderBundleIdentifier)"
app_id="$(extract PluginBundleID)"
extension_requirement="$(extract FilterDataProviderDesignatedRequirement)"

identifier_clause="identifier \"${extension_id}\""
if [[ "${extension_requirement}" != *"${identifier_clause}"* ]]; then
  echo "Profile requirement does not name the extension ${extension_id}: ${extension_requirement}" >&2
  exit 1
fi
# Literal substitution of the identifier clause, not a pattern match.
app_requirement="${extension_requirement/"${identifier_clause}"/identifier \"${app_id}\"}"

extension="${app}/Contents/Library/SystemExtensions/${extension_id}.systemextension"
if [[ ! -d "${extension}" ]]; then
  echo "Signed app does not contain the system extension: ${extension}" >&2
  exit 1
fi

verify() {
  local requirement="$1" bundle="$2"
  echo "codesign --verify --deep --strict -R='${requirement}' ${bundle}"
  if ! "${codesign}" --verify --deep --strict --verbose=2 "-R=${requirement}" "${bundle}"; then
    echo "::error::${bundle} does not satisfy the MDM profile requirement: ${requirement}" >&2
    echo "Managed Macs using docs/assets/mdm/automobile-network-filter.mobileconfig would stop pre-approving this release." >&2
    exit 1
  fi
}

verify "${extension_requirement}" "${extension}"
verify "${app_requirement}" "${app}"
echo "Network filter signature matches the committed MDM profile requirement."
