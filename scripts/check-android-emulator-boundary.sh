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
  matches="$(grep -nE 'spawn[[:space:]]*\(|execFile[[:space:]]*\(' "$source_file" || true)"
  if [[ -n "$matches" ]]; then
    violations+="${source_file#src/}: ${matches}"$'\n'
  fi
done < <(find src -type f -name '*.ts' ! -path "$OWNER" -exec grep -il 'emulator' {} +)

if [[ -n "$violations" ]]; then
  echo "error: Android emulator execution must use AndroidEmulatorClient:" >&2
  echo "$violations" >&2
  exit 1
fi

echo "android-emulator-boundary: no direct production emulator invocations."
