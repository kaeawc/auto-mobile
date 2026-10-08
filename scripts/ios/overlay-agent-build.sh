#!/usr/bin/env bash
# Build the iOS simulator overlay agent dylib (prototype for agent-authored overlays on iOS).
# The dylib is injected into a target app with SIMCTL_CHILD_DYLD_INSERT_LIBRARIES; see
# scripts/ios/overlay-agent-demo.ts. scripts/ios/swift-build.sh runs this in CI so a Swift or link
# regression in the UIKit sources fails there; the UIKit-free core is also a SwiftPM package
# (ios/overlay-agent) whose unit tests run on the macOS host.
#
# Usage: scripts/ios/overlay-agent-build.sh [output-dir]   (default: scratch/overlay-agent)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sources_root="${repo_root}/ios/overlay-agent/Sources"
out_dir="${1:-${repo_root}/scratch/overlay-agent}"
mkdir -p "${out_dir}"

sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
arch="$(uname -m)"
target="${arch}-apple-ios17.0-simulator"

xcrun --sdk iphonesimulator clang -target "${target}" -isysroot "${sdk}" \
  -c "${sources_root}/AutoMobileOverlayAgent/Loader.c" -o "${out_dir}/Loader.o"

# One module: the core sources compile alongside the UIKit sources, so they need no import.
swift_sources=()
while IFS= read -r -d '' file; do
  swift_sources+=("${file}")
done < <(find "${sources_root}/AutoMobileOverlayAgentCore" "${sources_root}/AutoMobileOverlayAgent" \
  -name '*.swift' -print0 | sort -z)
if [[ ${#swift_sources[@]} -eq 0 ]]; then
  echo "No Swift sources under ${sources_root}" >&2
  exit 1
fi

xcrun --sdk iphonesimulator swiftc \
  -target "${target}" \
  -sdk "${sdk}" \
  -swift-version 5 \
  -warnings-as-errors \
  -O \
  -module-name AutoMobileOverlayAgent \
  -emit-library \
  -Xlinker -install_name -Xlinker @rpath/AutoMobileOverlayAgent.dylib \
  -o "${out_dir}/AutoMobileOverlayAgent.dylib" \
  ${swift_sources[@]+"${swift_sources[@]}"} \
  "${out_dir}/Loader.o"

codesign --force --sign - "${out_dir}/AutoMobileOverlayAgent.dylib" > /dev/null
echo "${out_dir}/AutoMobileOverlayAgent.dylib"
