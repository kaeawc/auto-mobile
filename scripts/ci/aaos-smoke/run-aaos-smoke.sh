#!/usr/bin/env bash
# Advisory AAOS emulator smoke (#16746): install the non-Play automotive image, enable the
# device-condition flag in a run-private database, run scripts/ci/aaos-smoke/aaosSmoke.ts
# (which creates the AVD through startDevice createIfMissing), then capture emulator
# diagnostics whatever the outcome. Exits with the smoke's status.
#
# Env:
#   AAOS_SMOKE_OUT_DIR         artifact directory (default: scratch/aaos-smoke)
#   AAOS_SMOKE_SYSTEM_IMAGE    sdkmanager package (default: API 34 ext9 android-automotive x86_64)
#   AAOS_SMOKE_TIMEOUT_SECONDS wall-clock bound for the smoke run (default: 1800)
#   AAOS_SMOKE_BREAK_ASSERTION 1 swaps in an impossible assertion (proves failures are readable)
#   AAOS_SMOKE_SKIP_IMAGE_INSTALL 1 skips sdkmanager (image already installed)
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../../.." && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh
source "${project_root}/scripts/ios/run_with_timeout.sh"

if [[ $# -ne 0 ]]; then
  echo "usage: run-aaos-smoke.sh (no arguments; configure with AAOS_SMOKE_* env)" >&2
  exit 2
fi

out_dir="${AAOS_SMOKE_OUT_DIR:-${project_root}/scratch/aaos-smoke}"
system_image="${AAOS_SMOKE_SYSTEM_IMAGE:-system-images;android-34-ext9;android-automotive;x86_64}"
timeout_seconds="${AAOS_SMOKE_TIMEOUT_SECONDS:-1800}"
if [[ ! "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
  echo "AAOS_SMOKE_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi
if [[ "${system_image}" != *";android-automotive;"* ]]; then
  echo "AAOS_SMOKE_SYSTEM_IMAGE must be a non-Play android-automotive image: ${system_image}" >&2
  exit 2
fi
mkdir -p "${out_dir}"

if [[ "${AAOS_SMOKE_SKIP_IMAGE_INSTALL:-0}" != "1" ]]; then
  sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  sdkmanager="${sdk_root}/cmdline-tools/latest/bin/sdkmanager"
  if [[ -z "${sdk_root}" || ! -x "${sdkmanager}" ]]; then
    echo "sdkmanager not found under ANDROID_HOME/ANDROID_SDK_ROOT (${sdk_root:-unset})" >&2
    exit 1
  fi
  # `yes` exits on SIGPIPE once sdkmanager stops reading; that status is not a failure.
  { yes || true; } | "${sdkmanager}" --licenses > "${out_dir}/sdkmanager-licenses.log" 2>&1 || true
  "${sdkmanager}" --install "${system_image}" > "${out_dir}/sdkmanager-install.log" 2>&1 || {
    tail -n 50 "${out_dir}/sdkmanager-install.log" >&2
    echo "::error title=AAOS smoke::sdkmanager could not install ${system_image}"
    exit 1
  }
fi

# A run-private database keeps the enabled flag and the created AVD's records off any other host state.
export AUTOMOBILE_DB_PATH="${out_dir}/db/auto-mobile.db"
mkdir -p "$(dirname "${AUTOMOBILE_DB_PATH}")"
bun "${script_dir}/enableFeatureFlags.ts" device-condition

export AAOS_SMOKE_OUT_DIR="${out_dir}"
status=0
# pipefail makes the pipeline report the smoke's own status (124 on timeout).
run_with_timeout "${timeout_seconds}" bun "${script_dir}/aaosSmoke.ts" 2>&1 \
  | tee "${out_dir}/smoke.log" || status=$?

reason="AAOS smoke exited ${status}"
if [[ "${status}" -eq 124 ]]; then
  reason="AAOS smoke timed out after ${timeout_seconds}s"
  echo "::error title=AAOS smoke::${reason}"
fi
# Boot diagnostics (KVM, host memory/disk, emulator log tail, adb devices, logcat) the way
# .github/actions/android-emulator records them; best-effort and never masks the status.
bash "${project_root}/scripts/android/collect-emulator-diagnostics.sh" \
  "${out_dir}/diagnostics" "${reason}" || true

echo "AAOS smoke exit status: ${status} (advisory)"
exit "${status}"
