#!/usr/bin/env bash
#
# Selects an installed Xcode by version on the self-hosted Mac runners (#11011),
# where maxim-lobanov/setup-xcode cannot be used (it needs sudo xcode-select and
# would change the machine-wide default). Exports DEVELOPER_DIR for the remaining
# steps of the job only, so concurrent jobs on the Mac never fight over the
# global selection.
#
# Usage: scripts/ci/select-self-hosted-xcode.sh [--exact] [--print] [--require-metal] [<version>]   e.g. 27.2
#
# <version> defaults to the repository pin, AUTOMOBILE_XCODE_VERSION in
# scripts/ios/xcode_version.sh. --exact disables the same-major fallback below.
# --print writes only the selected DEVELOPER_DIR to stdout (messages go to stderr);
# scripts/ios/xcode_version.sh uses it to select the pin for local builds.
# --require-metal fails unless the selected Xcode has its Metal Toolchain component.
# Jobs that compile .metal sources pass it, so a self-hosted Mac without the
# toolchain fails in seconds with the install command instead of downloading
# ~839 MB inside the job (the component is per Xcode, installed once by the owner).
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

usage() {
  echo "usage: select-self-hosted-xcode.sh [--exact] [--print] [--require-metal] [<version>]" >&2
  exit 2
}

exact=false
print_only=false
require_metal=false
wanted=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --exact) exact=true ;;
    --print) print_only=true ;;
    --require-metal) require_metal=true ;;
    *)
      [[ -z "${wanted}" && $1 =~ ^[0-9]+(\.[0-9]+)*$ ]] || usage
      wanted="$1"
      ;;
  esac
  shift
done
if [[ -z "${wanted}" ]]; then
  # shellcheck source=scripts/ios/xcode_version.sh
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../ios" && pwd)/xcode_version.sh"
  wanted="${AUTOMOBILE_XCODE_VERSION}"
fi
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

if [[ -z "${selected}" && -n "${fallback}" && "${exact}" == false ]]; then
  echo "::warning::Xcode ${wanted} is not installed on this self-hosted runner; using the newest installed ${wanted_major}.x (${fallback_version}). Installed: ${found[*]}" >&2
  selected="${fallback}"
  wanted="${fallback_version}"
fi

if [[ -z "${selected}" ]]; then
  echo "::error::Xcode ${wanted} is not installed on this self-hosted runner. Installed: ${found[*]:-none}. Install it (e.g. 'xcodes install ${wanted}') or route the job to a hosted runner." >&2
  exit 1
fi

developer_dir="${selected}/Contents/Developer"
if [[ "${require_metal}" == true ]] \
  && ! DEVELOPER_DIR="${developer_dir}" xcrun --sdk iphonesimulator metal --version > /dev/null 2>&1; then
  echo "::error::Xcode ${wanted} at ${selected} has no Metal Toolchain, which this job needs to compile .metal sources. Install it once on the Mac as the runner user: DEVELOPER_DIR=$(printf '%q' "${developer_dir}") xcodebuild -downloadComponent metalToolchain" >&2
  exit 1
fi
if [[ "${print_only}" == true ]]; then
  echo "Selected Xcode ${wanted}: ${developer_dir}" >&2
  echo "${developer_dir}"
  exit 0
fi
echo "Selected Xcode ${wanted}: ${developer_dir}"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "DEVELOPER_DIR=${developer_dir}" >> "${GITHUB_ENV}"
fi
