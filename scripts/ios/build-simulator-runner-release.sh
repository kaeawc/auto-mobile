#!/usr/bin/env bash
# Package watchOS or visionOS simulator build-for-testing products as a release
# archive, mirroring build-tvos-runner-release.sh (#18136).
set -euo pipefail

usage='Usage: build-simulator-runner-release.sh --platform <watchos|visionos> [--output <zip-path>]'
platform=""
output_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform|--output)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "${usage}" >&2
        exit 2
      fi
      if [[ "$1" == --platform ]]; then platform="$2"; else output_path="$2"; fi
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "${platform}" in
  watchos)
    label="watchOS"
    scheme="CtrlProxyWatch"
    destination="generic/platform=watchOS Simulator"
    sdk="watchsimulator"
    ui_tests="CtrlProxyWatchUITests"
    ;;
  visionos)
    label="visionOS"
    scheme="AutoMobileVisionTest"
    destination="generic/platform=visionOS Simulator"
    sdk="xrsimulator"
    ui_tests="CtrlProxyVisionUITests"
    ;;
  *)
    echo "${usage}" >&2
    exit 2
    ;;
esac
output_path="${output_path:-./${platform}-runner-macos.zip}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../.." && pwd)"
# shellcheck source=scripts/lib/spotlight-exclude.sh
source "${project_root}/scripts/lib/spotlight-exclude.sh"
output_dir="$(dirname "${output_path}")"
mkdir_spotlight_excluded_within "${project_root}" "${output_dir}"
output_path="$(cd "${output_dir}" && pwd -P)/$(basename "${output_path}")"
archive_path="${output_path}.partial.zip"
derived_data="$(mktemp -d)"
trap 'rm -rf "${derived_data}"; rm -f "${archive_path}"' EXIT

project_dir="${project_root}/ios/control-proxy"
project="${project_dir}/CtrlProxy.xcodeproj"
if [[ ! -d "${project}" ]]; then
  (cd "${project_dir}" && xcodegen generate)
fi

xcodebuild build-for-testing \
  -project "${project}" \
  -scheme "${scheme}" \
  -destination "${destination}" \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath "${derived_data}"

products="${derived_data}/Build/Products"
shopt -s nullglob
xctestruns=("${products}"/*"${sdk}"*.xctestrun)
if [[ ${#xctestruns[@]} -ne 1 || ! -f "${xctestruns[0]}" ]]; then
  echo "Expected one ${sdk} xctestrun in Build/Products" >&2
  exit 1
fi
for artifact in \
  "${products}/Debug-${sdk}/${scheme}.app" \
  "${products}/Debug-${sdk}/${ui_tests}-Runner.app" \
  "${products}/Debug-${sdk}/${ui_tests}-Runner.app/PlugIns/${ui_tests}.xctest"; do
  if [[ ! -d "${artifact}" ]]; then
    echo "Missing ${label} runner artifact: ${artifact}" >&2
    exit 1
  fi
done

rm -f "${archive_path}"
(cd "${derived_data}" && zip -r "${archive_path}" Build/Products/)
mv "${archive_path}" "${output_path}"
sha256="$(shasum -a 256 "${output_path}" | cut -d' ' -f1)"
echo "sha256=${sha256}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "sha256=${sha256}" >> "${GITHUB_OUTPUT}"
fi
