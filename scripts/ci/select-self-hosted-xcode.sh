#!/usr/bin/env bash
#
# Selects an installed Xcode by version on the self-hosted Mac runners (#11011),
# where maxim-lobanov/setup-xcode cannot be used (it needs sudo xcode-select and
# would change the machine-wide default). Exports DEVELOPER_DIR for the remaining
# steps of the job only, so concurrent jobs on the Mac never fight over the
# global selection.
#
# Usage: scripts/ci/select-self-hosted-xcode.sh <version>   e.g. 26.5
#
# Looks at every Xcode*.app in XCODE_APPLICATIONS_DIR (default /Applications) and
# picks the one whose CFBundleShortVersionString is <version> or <version>.0.
# Fails with the installed versions listed when none matches: install the
# missing version (for example `xcodes install 26.5`) rather than building on a
# different toolchain, because these jobs verify a compiler floor.
#
# Environment:
#   XCODE_APPLICATIONS_DIR   where to look (default /Applications)
#   GITHUB_ENV               when set, DEVELOPER_DIR is appended for later steps

set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "usage: select-self-hosted-xcode.sh <version>" >&2
  exit 2
fi
wanted="$1"
apps_dir="${XCODE_APPLICATIONS_DIR:-/Applications}"

found=()
selected=""
shopt -s nullglob
for app in "${apps_dir}"/Xcode*.app; do
  plist="${app}/Contents/version.plist"
  [[ -f "${plist}" ]] || continue
  if ! version="$(plutil -extract CFBundleShortVersionString raw -o - "${plist}" 2>/dev/null)"; then
    continue
  fi
  found+=("${version} (${app})")
  if [[ -z "${selected}" && ( "${version}" == "${wanted}" || "${version}" == "${wanted}.0" ) ]]; then
    selected="${app}"
  fi
done

if [[ -z "${selected}" ]]; then
  echo "::error::Xcode ${wanted} is not installed on this self-hosted runner. Installed: ${found[*]:-none}. Install it (e.g. 'xcodes install ${wanted}') or route the job to a hosted runner." >&2
  exit 1
fi

developer_dir="${selected}/Contents/Developer"
echo "Selected Xcode ${wanted}: ${developer_dir}"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "DEVELOPER_DIR=${developer_dir}" >> "${GITHUB_ENV}"
fi
