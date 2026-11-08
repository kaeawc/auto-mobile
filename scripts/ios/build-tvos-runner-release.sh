#!/usr/bin/env bash
# Package tvOS simulator build-for-testing products without modifying the iOS IPA.
set -euo pipefail

output_path="./tvos-runner-macos.zip"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo 'Usage: build-tvos-runner-release.sh [--output <zip-path>]' >&2
        exit 2
      fi
      output_path="$2"
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

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
  -scheme AutoMobileTVTest \
  -destination 'generic/platform=tvOS Simulator' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath "${derived_data}"

products="${derived_data}/Build/Products"
shopt -s nullglob
xctestruns=("${products}"/*appletvsimulator*.xctestrun)
if [[ ${#xctestruns[@]} -ne 1 || ! -f "${xctestruns[0]}" ]]; then
  echo 'Expected one appletvsimulator xctestrun in Build/Products' >&2
  exit 1
fi
for artifact in \
  "${products}/Debug-appletvsimulator/AutoMobileTVTest.app" \
  "${products}/Debug-appletvsimulator/CtrlProxyTVUITests-Runner.app" \
  "${products}/Debug-appletvsimulator/CtrlProxyTVUITests-Runner.app/PlugIns/CtrlProxyTVUITests.xctest"; do
  if [[ ! -d "${artifact}" ]]; then
    echo "Missing tvOS runner artifact: ${artifact}" >&2
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
