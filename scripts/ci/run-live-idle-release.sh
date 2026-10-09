#!/usr/bin/env bash
# Run the live idle-release check against the emulator the android-emulator action booted
# (#10840). Inputs arrive as IDLE_SCENARIO and IDLE_TIMEOUT_MS so workflow_dispatch values are
# validated here instead of being spliced into workflow shell text.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

scenario="${IDLE_SCENARIO:-all}"
idle_timeout_ms="${IDLE_TIMEOUT_MS:-20000}"
serial="${IDLE_SERIAL:-emulator-5554}"
port="${IDLE_PORT:-3920}"

case "${scenario}" in
  all | active | no-heartbeat | idle | stdin-eof | selector | stream | provision) ;;
  *)
    echo "error: unsupported scenario '${scenario}' (two-devices needs a second emulator)." >&2
    exit 2
    ;;
esac
if [[ ! "${idle_timeout_ms}" =~ ^[0-9]+$ ]]; then
  echo "error: idle timeout must be an integer, got '${idle_timeout_ms}'." >&2
  exit 2
fi

cd "${REPO_ROOT}"
exec bash scripts/live-idle-release-check.sh --confirm-live \
  --serial "${serial}" --port "${port}" \
  --scenario "${scenario}" --idle-timeout-ms "${idle_timeout_ms}" \
  --evidence-dir "${REPO_ROOT}/scratch/live-idle-release-check/ci"
