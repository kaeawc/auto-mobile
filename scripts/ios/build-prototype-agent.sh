#!/usr/bin/env bash
# Build the universal (arm64 + x86_64) iOS simulator prototype-agent dylib and
# ad-hoc sign it. Each slice is compiled by scripts/ios/prototype-agent-build.sh.
# Ad-hoc only: the dylib is loaded exclusively by simulator processes (DYLD_INSERT_LIBRARIES), so no Developer ID or notarization applies.
#
# Usage: scripts/ios/build-prototype-agent.sh [output-dylib-path]
#   default output: scratch/prototype-agent/AutoMobilePrototypeAgent.dylib
# Env:
#   PROTOTYPE_AGENT_MIN_IOS  simulator deployment target (default 17.0)
#   PROTOTYPE_AGENT_SOURCES_ROOT  override the Sources dir (tests; see prototype-agent-build.sh)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
min_ios="${PROTOTYPE_AGENT_MIN_IOS:-17.0}"
output_path="${1:-${repo_root}/scratch/prototype-agent/AutoMobilePrototypeAgent.dylib}"
slices=(arm64 x86_64)

output_dir="$(dirname "${output_path}")"
mkdir -p "${output_dir}"
output_path="$(cd "${output_dir}" && pwd -P)/$(basename "${output_path}")"

build_script="${repo_root}/scripts/ios/prototype-agent-build.sh"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

# Compile each slice with the shared per-architecture build script.
slice_paths=()
for arch in "${slices[@]}"; do
  slice_dir="${work_dir}/${arch}"
  PROTOTYPE_AGENT_ARCH="${arch}" PROTOTYPE_AGENT_MIN_IOS="${min_ios}" bash "${build_script}" "${slice_dir}" >/dev/null
  slice_paths+=("${slice_dir}/AutoMobilePrototypeAgent.dylib")
done

partial_path="${output_path}.partial"
rm -f "${partial_path}"
lipo -create ${slice_paths[@]+"${slice_paths[@]}"} -output "${partial_path}"

architectures="$(lipo -archs "${partial_path}")"
for arch in "${slices[@]}"; do
  if [[ " ${architectures} " != *" ${arch} "* ]]; then
    rm -f "${partial_path}"
    echo "prototype agent is missing ${arch}: ${architectures}" >&2
    exit 1
  fi
done

codesign --force --sign - "${partial_path}" >/dev/null
mv -f "${partial_path}" "${output_path}"
echo "${output_path}"
