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
evidence_dir="${IDLE_EVIDENCE_DIR:-${REPO_ROOT}/scratch/live-idle-release-check/ci}"

case "${scenario}" in
  all | active | no-heartbeat | idle | stdin-eof | selector | observe-only | stream | provision) ;;
  *)
    echo "error: unsupported scenario '${scenario}' (two-devices needs a second emulator)." >&2
    exit 2
    ;;
esac
if [[ ! "${idle_timeout_ms}" =~ ^[0-9]+$ ]]; then
  echo "error: idle timeout must be an integer, got '${idle_timeout_ms}'." >&2
  exit 2
fi

# A scenario verdict survives both the script retry and the emulator action retry (#11368).
# Leave the list intact: the nightly alert reads it. Failures before any scenario can still retry.
if [[ -s "${evidence_dir}/failed-scenarios.txt" ]]; then
  failed="$(paste -sd ',' "${evidence_dir}/failed-scenarios.txt" | sed 's/,/, /g')"
  echo "error: ${failed}: an earlier attempt in this job failed these scenarios; a scenario failure is a verdict and is not retried (#11368); removing ${evidence_dir}/failed-scenarios.txt allows a new run." >&2
  exit 1
fi

# The android-emulator action exports AUTOMOBILE_CTRL_PROXY_APK_PATH relative to its working
# directory (android/). The private daemon resolves a relative override against its launch cwd
# (the throwaway work dir), where it does not exist, so hand it an absolute path (#10840).
apk_path="${AUTOMOBILE_CTRL_PROXY_APK_PATH:-control-proxy/build/outputs/apk/debug/control-proxy-debug.apk}"
if [[ "${apk_path}" != /* ]]; then
  apk_path="${REPO_ROOT}/android/${apk_path}"
fi
if [[ ! -f "${apk_path}" ]]; then
  echo "error: CtrlProxy APK not found at ${apk_path}." >&2
  exit 2
fi
export AUTOMOBILE_CTRL_PROXY_APK_PATH="${apk_path}"

cd "${REPO_ROOT}"
exec bash "${IDLE_CHECK_SCRIPT:-scripts/live-idle-release-check.sh}" --confirm-live \
  --serial "${serial}" --port "${port}" \
  --scenario "${scenario}" --idle-timeout-ms "${idle_timeout_ms}" \
  --evidence-dir "${evidence_dir}"
