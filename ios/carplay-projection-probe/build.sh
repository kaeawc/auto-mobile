#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-${script_dir}/.build/carplay-projection-probe}"
mkdir -p -- "$(dirname -- "$out")"
xcrun -sdk iphonesimulator clang -target arm64-apple-ios27.0-simulator \
  -fobjc-arc -framework Foundation -framework QuartzCore \
  "${script_dir}/probe.m" -o "$out"
codesign -f -s - "$out"
