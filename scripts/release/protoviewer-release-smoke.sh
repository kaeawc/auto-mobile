#!/usr/bin/env bash
# ProtoViewer release-artifact device checks (#15387): upgrade in place and minified smoke.
# Usage: scripts/release/protoviewer-release-smoke.sh <android|ios> --device <serial|udid>
#          [--previous <apk|.app>] [--candidate <apk|.app>] [--mode upgrade|smoke|all] [--build]
#   --build      build the candidate first: Android runs :protoviewer:assembleRelease with R8
#                minification on (-Pautomobile.protoviewer.minifyRelease=true); iOS builds the
#                release-style simulator app into scratch/protoviewer-smoke/.
#   --candidate  defaults to the artifact --build produces.
#   --previous   the earlier release to upgrade from; required for --mode upgrade and all.
# Needs a booted emulator or simulator, and only touches the device it is given. It never
# dispatches a workflow and never uninstalls the app. Exit 0 pass, 1 failed check, 2 usage.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

platform="${1:-}"
case "${platform}" in
  android | ios) shift ;;
  *) usage ;;
esac

device=""
previous=""
candidate=""
mode="all"
build=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --previous) previous="${2:-}"; shift 2 ;;
    --candidate) candidate="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    --build) build=1; shift ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

case "${mode}" in
  upgrade | smoke | all) ;;
  *) echo "unknown --mode: ${mode}" >&2; usage ;;
esac
if [[ -z "${device}" ]]; then
  echo "--device is required" >&2
  usage
fi
if [[ "${mode}" != "smoke" && -z "${previous}" ]]; then
  echo "--previous is required for --mode ${mode}" >&2
  usage
fi

ios_out="${repo_root}/scratch/protoviewer-smoke"
if [[ ${build} -eq 1 ]]; then
  if [[ "${platform}" == "android" ]]; then
    (cd "${repo_root}/android" && ./gradlew :protoviewer:assembleRelease -Pautomobile.protoviewer.minifyRelease=true)
    candidate="${candidate:-${repo_root}/android/protoviewer/build/outputs/apk/release/protoviewer-release.apk}"
  else
    PROTOVIEWER_CLEARTEXT=0 bash "${repo_root}/scripts/ios/protoviewer-build.sh" "${ios_out}"
    candidate="${candidate:-${ios_out}/ProtoViewer.app}"
  fi
fi
if [[ -z "${candidate}" ]]; then
  echo "--candidate is required unless --build is given" >&2
  usage
fi
for artifact in "${candidate}" "${previous}"; do
  if [[ -n "${artifact}" && ! -e "${artifact}" ]]; then
    echo "artifact not found: ${artifact}" >&2
    exit 2
  fi
done

args=("${platform}" --device "${device}" --candidate "${candidate}" --mode "${mode}")
if [[ -n "${previous}" ]]; then
  args+=(--previous "${previous}")
fi
exec bun "${repo_root}/scripts/release/protoviewer-release-smoke.ts" "${args[@]}"
