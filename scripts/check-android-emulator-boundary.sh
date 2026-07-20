#!/usr/bin/env bash
# Keep emulator process execution behind AndroidEmulatorClient. This deliberately
# checks only literal emulator invocations: scripts and path-discovery diagnostics
# are outside the production TypeScript runtime boundary.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWNER="src/utils/android-cmdline-tools/AndroidEmulatorClient.ts"

cd "$ROOT_DIR"

pattern="(?:spawn|execFile|exec)\\s*\\(\\s*(?:[\\\"'\\\`][^\\\"'\\\`]*emulator[^\\\"'\\\`]*[\\\"'\\\`]|(?=[A-Za-z0-9_$]*[Ee]mulator)[A-Za-z_$][A-Za-z0-9_$]*)"
violations="$(rg -n -P "$pattern" src \
  --glob '*.ts' \
  --glob "!${OWNER}" \
  || true)"

if [[ -n "$violations" ]]; then
  echo "error: Android emulator execution must use AndroidEmulatorClient:" >&2
  echo "$violations" >&2
  exit 1
fi

echo "android-emulator-boundary: no direct production emulator invocations."
