#!/usr/bin/env bash
# Build the ProtoViewer release artifacts and check them against the artifact policy (#14154).
# Usage: scripts/release/protoviewer-artifact-policy.sh [--android] [--ios] [--no-build]
#   Default: --android, plus --ios on macOS. --no-build checks the artifacts already on disk.
# Android builds :protoviewer:assembleRelease (needs android/local.properties); iOS builds the
# release-style simulator app (PROTOVIEWER_CLEARTEXT=0) into scratch/protoviewer-policy/.
# Local and PR builds carry the -SNAPSHOT versionName, so Android runs with --allow-snapshot; the
# release workflow (.github/workflows/verify-protoviewer-artifact-policy.yml) does not.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
gate=(bun "${repo_root}/scripts/release/check-protoviewer-artifact-policy.ts")
android=0
ios=0
build=1
for arg in "$@"; do
  case "${arg}" in
    --android) android=1 ;;
    --ios) ios=1 ;;
    --no-build) build=0 ;;
    *) echo "unknown option: ${arg}" >&2; exit 2 ;;
  esac
done
if [[ ${android} -eq 0 && ${ios} -eq 0 ]]; then
  android=1
  if [[ "$(uname -s)" == "Darwin" ]]; then ios=1; fi
fi

status=0
if [[ ${android} -eq 1 ]]; then
  if [[ ${build} -eq 1 ]]; then
    (cd "${repo_root}/android" && ./gradlew :protoviewer:assembleRelease)
  fi
  "${gate[@]}" android \
    "${repo_root}/android/protoviewer/build/outputs/apk/release/protoviewer-release.apk" \
    --allow-snapshot || status=1
fi
if [[ ${ios} -eq 1 ]]; then
  out_dir="${repo_root}/scratch/protoviewer-policy"
  if [[ ${build} -eq 1 ]]; then
    PROTOVIEWER_CLEARTEXT=0 bash "${repo_root}/scripts/ios/protoviewer-build.sh" "${out_dir}"
  fi
  "${gate[@]}" ios "${out_dir}/ProtoViewer.app" --platform iphonesimulator || status=1
fi
exit "${status}"
