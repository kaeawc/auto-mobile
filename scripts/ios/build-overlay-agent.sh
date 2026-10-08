#!/usr/bin/env bash
# Build the universal (arm64 + x86_64) iOS simulator overlay-agent dylib and
# ad-hoc sign it. Each slice is compiled by scripts/ios/overlay-agent-build.sh.
# Ad-hoc only: the dylib is loaded exclusively by simulator processes (DYLD_INSERT_LIBRARIES), so no Developer ID or notarization applies.
#
# Usage: scripts/ios/build-overlay-agent.sh [output-dylib-path]
#   default output: scratch/overlay-agent/AutoMobileOverlayAgent.dylib
# Env:
#   OVERLAY_AGENT_MIN_IOS  simulator deployment target (default 17.0)
#   OVERLAY_AGENT_SOURCES_ROOT  override the Sources dir (tests; see overlay-agent-build.sh)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
min_ios="${OVERLAY_AGENT_MIN_IOS:-17.0}"
output_path="${1:-${repo_root}/scratch/overlay-agent/AutoMobileOverlayAgent.dylib}"
slices=(arm64 x86_64)

output_dir="$(dirname "${output_path}")"
mkdir -p "${output_dir}"
output_path="$(cd "${output_dir}" && pwd -P)/$(basename "${output_path}")"

build_script="${repo_root}/scripts/ios/overlay-agent-build.sh"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

# Compile each slice with the shared per-architecture build script.
slice_paths=()
for arch in "${slices[@]}"; do
  slice_dir="${work_dir}/${arch}"
  OVERLAY_AGENT_ARCH="${arch}" OVERLAY_AGENT_MIN_IOS="${min_ios}" bash "${build_script}" "${slice_dir}" >/dev/null
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
