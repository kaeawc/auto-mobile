#!/usr/bin/env bash
# ProtoViewer release-artifact device checks (#15387): upgrade in place and minified smoke.
# Usage: scripts/release/protoviewer-release-smoke.sh <android|ios> --device <serial|udid>
#          [--previous <apk|.app>] [--candidate <apk|.app>] [--mode upgrade|smoke|all] [--build]
#          [--duo --posture-command <executable>] [--screenshots-dir <dir>]
#   --duo        iOS only: capture primary closed, primary-1 opened, then fold back.
#   --posture-command  executable receiving closed/opened; exit 0 means posture reached.
#   --screenshots-dir  PNG output (default scratch/protoviewer-smoke/duo, relative to cwd).
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
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
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
duo=0
posture_command=""
screenshots_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --previous) previous="${2:-}"; shift 2 ;;
    --candidate) candidate="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    --build) build=1; shift ;;
    --duo) duo=1; shift ;;
    --posture-command | --screenshots-dir)
      if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
        echo "$1 requires a value" >&2
        usage
      fi
      if [[ "$1" == --posture-command ]]; then posture_command="$2"; else screenshots_dir="$2"; fi
      shift 2 ;;

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

if [[ ${duo} -eq 1 ]]; then
  if [[ "${platform}" != "ios" || -z "${posture_command}" ]]; then
    echo "--duo requires platform ios and --posture-command" >&2
    usage
  fi
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
if [[ ${duo} -eq 1 ]]; then args+=(--duo); fi
if [[ -n "${posture_command}" ]]; then args+=(--posture-command "${posture_command}"); fi
if [[ -n "${screenshots_dir}" ]]; then args+=(--screenshots-dir "${screenshots_dir}"); fi
exec bun "${repo_root}/scripts/release/protoviewer-release-smoke.ts" "${args[@]}"
