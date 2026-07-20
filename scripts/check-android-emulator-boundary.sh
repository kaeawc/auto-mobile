#!/usr/bin/env bash
# Keep emulator process execution behind AndroidEmulatorClient. The TypeScript
# scanner distinguishes process execution from unrelated calls such as RegExp.exec.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

exec bun scripts/check-android-emulator-boundary.ts
