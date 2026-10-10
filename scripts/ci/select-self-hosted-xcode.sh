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
# When <version> is not installed, falls back to the newest installed Xcode of the
# same major that is at least <version> (the jobs verify a compiler floor, so a
# newer minor of the same major keeps the guarantee) and says so. Fails with the
# installed versions listed when no such Xcode exists; it never crosses majors.
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
fallback=""
fallback_version=""
wanted_major="${wanted%%.*}"

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
  elif [[ "${version%%.*}" == "${wanted_major}" ]]; then
    # Same major: a fallback candidate only when >= wanted (the compiler floor)
    # and newer than the best candidate so far.
    floor="${fallback_version:-${wanted}}"
    lowest="$(printf '%s\n%s\n' "${floor}" "${version}" | sort -V | head -n1)"
    if [[ "${lowest}" == "${floor}" && ( -z "${fallback}" || "${version}" != "${floor}" ) ]]; then
      fallback="${app}"
      fallback_version="${version}"
    fi
  fi
done

if [[ -z "${selected}" && -n "${fallback}" ]]; then
  echo "::warning::Xcode ${wanted} is not installed on this self-hosted runner; using the newest installed ${wanted_major}.x (${fallback_version}). Installed: ${found[*]}" >&2
  selected="${fallback}"
  wanted="${fallback_version}"
fi

if [[ -z "${selected}" ]]; then
  echo "::error::Xcode ${wanted} is not installed on this self-hosted runner. Installed: ${found[*]:-none}. Install it (e.g. 'xcodes install ${wanted}') or route the job to a hosted runner." >&2
  exit 1
fi

developer_dir="${selected}/Contents/Developer"
echo "Selected Xcode ${wanted}: ${developer_dir}"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "DEVELOPER_DIR=${developer_dir}" >> "${GITHUB_ENV}"
fi
