#!/usr/bin/env bash
# Build the iOS simulator overlay agent dylib (prototype for agent-authored overlays on iOS).
# The dylib is injected into a target app with SIMCTL_CHILD_DYLD_INSERT_LIBRARIES; see
# scripts/ios/overlay-agent-demo.ts.
#
# Usage: scripts/ios/overlay-agent-build.sh [output-dir]   (default: scratch/overlay-agent)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
src_dir="${repo_root}/ios/overlay-agent/Sources/AutoMobileOverlayAgent"
out_dir="${1:-${repo_root}/scratch/overlay-agent}"
mkdir -p "${out_dir}"

sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
arch="$(uname -m)"
target="${arch}-apple-ios17.0-simulator"

xcrun clang -target "${target}" -isysroot "${sdk}" -c "${src_dir}/Loader.c" -o "${out_dir}/Loader.o"

swift_sources=()
while IFS= read -r -d '' file; do
  swift_sources+=("${file}")
done < <(find "${src_dir}" -name '*.swift' -print0 | sort -z)
if [[ ${#swift_sources[@]} -eq 0 ]]; then
  echo "No Swift sources under ${src_dir}" >&2
  exit 1
fi

xcrun swiftc \
  -target "${target}" \
  -sdk "${sdk}" \
  -swift-version 5 \
  -O \
  -module-name AutoMobileOverlayAgent \
  -emit-library \
  -Xlinker -install_name -Xlinker @rpath/AutoMobileOverlayAgent.dylib \
  -o "${out_dir}/AutoMobileOverlayAgent.dylib" \
  ${swift_sources[@]+"${swift_sources[@]}"} \
  "${out_dir}/Loader.o"

codesign --force --sign - "${out_dir}/AutoMobileOverlayAgent.dylib" >/dev/null
echo "${out_dir}/AutoMobileOverlayAgent.dylib"
