#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ndk_root=""

for candidate in "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}"; do
  if [[ -n "$candidate" && -d "$candidate" ]]; then
    ndk_root="$candidate"
    break
  fi
done

if [[ -z "$ndk_root" && -d "$sdk_root/ndk" ]]; then
  revisions=()
  for candidate in "$sdk_root/ndk/"*; do
    [[ -d "$candidate" ]] || continue
    revisions+=("${candidate##*/}")
  done
  if [[ ${#revisions[@]} -gt 0 ]]; then
    # NDK revision directories use dotted numbers. Numeric component sorting
    # works on both BSD and GNU sort (macOS does not provide sort -V).
    newest="$(printf '%s\n' "${revisions[@]}" | LC_ALL=C sort -t . -k1,1n -k2,2n -k3,3n -k4,4n | tail -n 1)"
    ndk_root="$sdk_root/ndk/$newest"
  fi
fi

if [[ -z "$ndk_root" ]]; then
  echo "No Android NDK found. Set ANDROID_NDK_HOME or ANDROID_NDK_ROOT, or install an NDK under $sdk_root/ndk." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) hosts=(darwin-x86_64 linux-x86_64) ;;
  Linux) hosts=(linux-x86_64 darwin-x86_64) ;;
  *) echo "Unsupported NDK build host: $(uname -s)" >&2; exit 1 ;;
esac

toolchain=""
for host in "${hosts[@]}"; do
  candidate="$ndk_root/toolchains/llvm/prebuilt/$host"
  if [[ -d "$candidate" ]]; then
    toolchain="$candidate/bin"
    break
  fi
done
if [[ -z "$toolchain" ]]; then
  echo "No supported LLVM prebuilt directory found in Android NDK: $ndk_root" >&2
  exit 1
fi

abis=(arm64-v8a x86_64)
targets=(aarch64-linux-android x86_64-linux-android)
# Check both compilers before producing either output.
for target in "${targets[@]}"; do
  if [[ ! -x "$toolchain/${target}26-clang" ]]; then
    echo "Android NDK compiler not found or not executable: $toolchain/${target}26-clang" >&2
    exit 1
  fi
done

output_root="${LMK_PRESSURE_OUT:-build/lmk-pressure}"
for i in "${!abis[@]}"; do
  output="$output_root/${abis[$i]}/lmk_pressure"
  mkdir -p "$(dirname "$output")"
  "$toolchain/${targets[$i]}26-clang" -O2 -fPIE -pie \
    "$PROJECT_ROOT/android/lmk-pressure/lmk_pressure.c" -o "$output"
  printf '%s\n' "$output"
done
