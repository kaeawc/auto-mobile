#!/usr/bin/env bash
# Build the universal (arm64 + x86_64) iOS simulator overlay-agent dylib and
# ad-hoc sign it. Ad-hoc only: the dylib is loaded exclusively by simulator
# processes (DYLD_INSERT_LIBRARIES), so no Developer ID or notarization applies.
#
# Usage: scripts/ios/build-overlay-agent.sh [output-dylib-path]
#   default output: scratch/overlay-agent/AutoMobileOverlayAgent.dylib
# Env:
#   OVERLAY_AGENT_MIN_IOS  simulator deployment target (default 17.0)
#   OVERLAY_AGENT_SOURCE_DIR  override the sources dir (tests)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
src_dir="${OVERLAY_AGENT_SOURCE_DIR:-${repo_root}/ios/overlay-agent/Sources/AutoMobileOverlayAgent}"
min_ios="${OVERLAY_AGENT_MIN_IOS:-17.0}"
output_path="${1:-${repo_root}/scratch/overlay-agent/AutoMobileOverlayAgent.dylib}"
slices=(arm64 x86_64)

output_dir="$(dirname "${output_path}")"
mkdir -p "${output_dir}"
output_path="$(cd "${output_dir}" && pwd -P)/$(basename "${output_path}")"

swift_sources=()
while IFS= read -r -d '' file; do
  swift_sources+=("${file}")
done < <(find "${src_dir}" -name '*.swift' -print0 | sort -z)
if [[ ${#swift_sources[@]} -eq 0 ]]; then
  echo "No Swift sources under ${src_dir}" >&2
  exit 1
fi
if [[ ! -f "${src_dir}/Loader.c" ]]; then
  echo "Loader.c not found under ${src_dir}" >&2
  exit 1
fi

sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

slice_paths=()
for arch in "${slices[@]}"; do
  target="${arch}-apple-ios${min_ios}-simulator"
  slice_dir="${work_dir}/${arch}"
  mkdir -p "${slice_dir}"

  xcrun clang -target "${target}" -isysroot "${sdk}" -c "${src_dir}/Loader.c" -o "${slice_dir}/Loader.o"
  xcrun swiftc \
    -target "${target}" \
    -sdk "${sdk}" \
    -swift-version 5 \
    -O \
    -module-name AutoMobileOverlayAgent \
    -emit-library \
    -Xlinker -install_name -Xlinker @rpath/AutoMobileOverlayAgent.dylib \
    -o "${slice_dir}/AutoMobileOverlayAgent.dylib" \
    "${swift_sources[@]}" \
    "${slice_dir}/Loader.o"
  slice_paths+=("${slice_dir}/AutoMobileOverlayAgent.dylib")
done

partial_path="${output_path}.partial"
rm -f "${partial_path}"
lipo -create "${slice_paths[@]}" -output "${partial_path}"

architectures="$(lipo -archs "${partial_path}")"
for arch in "${slices[@]}"; do
  if [[ " ${architectures} " != *" ${arch} "* ]]; then
    rm -f "${partial_path}"
    echo "overlay agent is missing ${arch}: ${architectures}" >&2
    exit 1
  fi
done

codesign --force --sign - "${partial_path}" >/dev/null
mv -f "${partial_path}" "${output_path}"
echo "${output_path}"
