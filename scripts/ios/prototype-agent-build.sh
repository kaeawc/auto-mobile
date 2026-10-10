#!/usr/bin/env bash
# Build the iOS simulator prototype agent dylib (prototype for agent-authored prototypes on iOS).
# The dylib is injected into a target app with SIMCTL_CHILD_DYLD_INSERT_LIBRARIES; see
# scripts/ios/prototype-agent-demo.ts. scripts/ios/swift-build.sh runs this in CI so a Swift or link
# regression in the UIKit sources fails there; the UIKit-free core is also a SwiftPM package
# (ios/prototype-agent) whose unit tests run on the macOS host.
#
# This is the single compile path: scripts/ios/build-prototype-agent.sh (the universal release build)
# calls it once per architecture.
#
# Usage: scripts/ios/prototype-agent-build.sh [output-dir]   (default: scratch/prototype-agent)
# Env:
#   PROTOTYPE_AGENT_ARCH          architecture to build (default: host `uname -m`)
#   PROTOTYPE_AGENT_MIN_IOS       simulator deployment target (default 17.0)
#   PROTOTYPE_AGENT_SOURCES_ROOT  override the Sources dir (tests)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sources_root="${PROTOTYPE_AGENT_SOURCES_ROOT:-${repo_root}/ios/prototype-agent/Sources}"
out_dir="${1:-${repo_root}/scratch/prototype-agent}"
mkdir -p "${out_dir}"

sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
arch="${PROTOTYPE_AGENT_ARCH:-$(uname -m)}"
min_ios="${PROTOTYPE_AGENT_MIN_IOS:-17.0}"
target="${arch}-apple-ios${min_ios}-simulator"

xcrun --sdk iphonesimulator clang -target "${target}" -isysroot "${sdk}" \
  -c "${sources_root}/AutoMobilePrototypeAgent/Loader.c" -o "${out_dir}/Loader.o"

# One module: the core sources compile alongside the UIKit sources, so they need no import.
swift_sources=()
while IFS= read -r -d '' file; do
  swift_sources+=("${file}")
done < <(find "${sources_root}/AutoMobilePrototypeAgentCore" "${sources_root}/AutoMobilePrototypeAgent" \
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
  -module-name AutoMobilePrototypeAgent \
  -emit-library \
  -Xlinker -install_name -Xlinker @rpath/AutoMobilePrototypeAgent.dylib \
  -o "${out_dir}/AutoMobilePrototypeAgent.dylib" \
  ${swift_sources[@]+"${swift_sources[@]}"} \
  "${out_dir}/Loader.o"

codesign --force --sign - "${out_dir}/AutoMobilePrototypeAgent.dylib" > /dev/null
echo "${out_dir}/AutoMobilePrototypeAgent.dylib"
