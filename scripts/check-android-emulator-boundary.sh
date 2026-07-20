#!/usr/bin/env bash
# Keep emulator process execution behind AndroidEmulatorClient. This deliberately
# checks only literal emulator invocations: scripts and path-discovery diagnostics
# are outside the production TypeScript runtime boundary.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWNER="src/utils/android-cmdline-tools/AndroidEmulatorClient.ts"

cd "$ROOT_DIR"

violations=""
while IFS= read -r source_file; do
  matches="$(rg -n -P '\b(?:spawn|execFile)\s*\(' "$source_file" || true)"
  if [[ -n "$matches" ]]; then
    violations+="${source_file#src/}: ${matches}"$'\n'
  fi
done < <(rg -il 'emulator' src --glob '*.ts' --glob "!${OWNER}")

if [[ -n "$violations" ]]; then
  echo "error: Android emulator execution must use AndroidEmulatorClient:" >&2
  echo "$violations" >&2
  exit 1
fi

echo "android-emulator-boundary: no direct production emulator invocations."
