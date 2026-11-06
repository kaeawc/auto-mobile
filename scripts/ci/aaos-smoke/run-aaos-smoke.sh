#!/usr/bin/env bash
# Advisory AAOS emulator smoke (#16746): install the non-Play automotive image, enable the
# device-condition flag in a run-private database, run scripts/ci/aaos-smoke/aaosSmoke.ts
# (which creates the AVD through startDevice createIfMissing), then capture emulator
# diagnostics whatever the outcome. Exits with the smoke's status. A setup failure (bad env,
# missing sdkmanager, failed install, failed flag enable) also collects diagnostics and adds a
# failure line to $GITHUB_STEP_SUMMARY through the EXIT trap.
#
# Env:
#   AAOS_SMOKE_OUT_DIR         artifact directory (default: scratch/aaos-smoke)
#   AAOS_SMOKE_OS_VERSION      Android version the plan pins startDevice to (default: 14); the
#                              system image's API level must match it (14 = API 34)
#   AAOS_SMOKE_SYSTEM_IMAGE    sdkmanager package (default: API 34 ext9 android-automotive x86_64)
#   AAOS_SMOKE_TIMEOUT_SECONDS wall-clock bound for the smoke run (default: 1800)
#   AAOS_SMOKE_SDKMANAGER_TIMEOUT_SECONDS bound for each sdkmanager call (default: 900)
#   AAOS_SMOKE_BREAK_ASSERTION 1 swaps in an impossible assertion (proves failures are readable)
#   AAOS_SMOKE_SKIP_IMAGE_INSTALL 1 skips sdkmanager (image already installed)
#   AAOS_SMOKE_DIAGNOSTICS_SCRIPT diagnostics collector (default:
#                              scripts/android/collect-emulator-diagnostics.sh; tests stub it)
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../../.." && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh
source "${project_root}/scripts/ios/run_with_timeout.sh"
# shellcheck source=scripts/ci/emulator-smoke/install-system-image.sh
source "${project_root}/scripts/ci/emulator-smoke/install-system-image.sh"

if [[ $# -ne 0 ]]; then
  echo "usage: run-aaos-smoke.sh (no arguments; configure with AAOS_SMOKE_* env)" >&2
  exit 2
fi

out_dir="${AAOS_SMOKE_OUT_DIR:-${project_root}/scratch/aaos-smoke}"
diagnostics_script="${AAOS_SMOKE_DIAGNOSTICS_SCRIPT:-${project_root}/scripts/android/collect-emulator-diagnostics.sh}"
# What the run is doing, named in the failure line when setup exits early.
phase="validating AAOS_SMOKE_* settings"
diagnostics_collected=0

collect_diagnostics() {
  diagnostics_collected=1
  # Boot diagnostics (KVM, host memory/disk, emulator log tail, adb devices, logcat) the way
  # .github/actions/android-emulator records them; best-effort and never masks the status.
  bash "${diagnostics_script}" "${out_dir}/diagnostics" "$1" || true
}

append_step_summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "${GITHUB_STEP_SUMMARY}" || true
  fi
}

# shellcheck disable=SC2317,SC2329 # Invoked by the EXIT trap.
on_exit() {
  local status=$?
  if [[ "${status}" -ne 0 && "${diagnostics_collected}" -eq 0 ]]; then
    local reason="AAOS smoke setup failed while ${phase} (exit ${status})"
    echo "::error title=AAOS smoke::${reason}"
    collect_diagnostics "${reason}"
    append_step_summary $'## AAOS emulator smoke (advisory)\n\n**Failed** during setup: '"${reason}"$'\n'
  fi
}
trap on_exit EXIT

# The API level Android release <version> ships as: 12 = 31, 12L = 32, then 13 = 33 onward.
# Prints nothing for a value that is not a release.
api_level_for_os_version() {
  case "$1" in
    12) echo 31 ;;
    12L) echo 32 ;;
    *)
      if [[ "$1" =~ ^[1-9][0-9]*$ && "$1" -ge 13 ]]; then
        echo $(($1 + 20))
      fi
      ;;
  esac
}

os_version="${AAOS_SMOKE_OS_VERSION:-14}"
system_image="${AAOS_SMOKE_SYSTEM_IMAGE:-system-images;android-34-ext9;android-automotive;x86_64}"
timeout_seconds="${AAOS_SMOKE_TIMEOUT_SECONDS:-1800}"
sdkmanager_timeout_seconds="${AAOS_SMOKE_SDKMANAGER_TIMEOUT_SECONDS:-900}"
for setting in AAOS_SMOKE_TIMEOUT_SECONDS:"${timeout_seconds}" \
  AAOS_SMOKE_SDKMANAGER_TIMEOUT_SECONDS:"${sdkmanager_timeout_seconds}"; do
  if [[ ! "${setting#*:}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${setting%%:*} must be a positive integer" >&2
    exit 2
  fi
done
if [[ "${system_image}" != *";android-automotive;"* ]]; then
  echo "AAOS_SMOKE_SYSTEM_IMAGE must be a non-Play android-automotive image: ${system_image}" >&2
  exit 2
fi
expected_api="$(api_level_for_os_version "${os_version}")"
if [[ -z "${expected_api}" ]]; then
  echo "AAOS_SMOKE_OS_VERSION must be an Android release such as 13, 14 or 15: ${os_version}" >&2
  exit 2
fi
# The platform segment is android-<api> or android-<api>-ext<n>; startDevice is pinned to
# os_version, so an image at any other API level would install and then never be used.
platform_segment="$(printf '%s' "${system_image}" | cut -d';' -f2)"
if [[ ! "${platform_segment}" =~ ^android-([0-9]+)(-ext[0-9]+)?$ ]]; then
  echo "AAOS_SMOKE_SYSTEM_IMAGE has no android-<api> platform segment: ${system_image}" >&2
  exit 2
fi
image_api="${BASH_REMATCH[1]}"
if [[ "${image_api}" != "${expected_api}" ]]; then
  echo "AAOS_SMOKE_SYSTEM_IMAGE is API ${image_api} but AAOS_SMOKE_OS_VERSION=${os_version} needs API ${expected_api}; set both together" >&2
  exit 2
fi
phase="creating ${out_dir}"
mkdir -p "${out_dir}"

if [[ "${AAOS_SMOKE_SKIP_IMAGE_INSTALL:-0}" != "1" ]]; then
  phase="locating sdkmanager"
  sdkmanager="$(locate_sdkmanager)"
  phase="installing ${system_image}"
  install_system_image "AAOS smoke" "${sdkmanager}" "${sdkmanager_timeout_seconds}" \
    "${system_image}" "${out_dir}"
fi

# A run-private database keeps the enabled flag and the created AVD's records off any other host state.
phase="enabling the device-condition feature flag"
export AUTOMOBILE_DB_PATH="${out_dir}/db/auto-mobile.db"
mkdir -p "$(dirname "${AUTOMOBILE_DB_PATH}")"
bun "${script_dir}/enableFeatureFlags.ts" device-condition

phase="running the smoke"
export AAOS_SMOKE_OUT_DIR="${out_dir}"
export AAOS_SMOKE_OS_VERSION="${os_version}"
# A summary left by an earlier run in the same directory would hide a crash below.
rm -f "${out_dir}/summary.md"
# pipefail makes the pipeline report the smoke's own status (124 on timeout). set -e is
# lifted around the call rather than using `|| status=$?`, which would disable it inside
# run_with_timeout (SC2310).
set +e
run_with_timeout "${timeout_seconds}" bun "${script_dir}/aaosSmoke.ts" 2>&1 \
  | tee "${out_dir}/smoke.log"
status=$?
set -e

reason="AAOS smoke exited ${status}"
if [[ "${status}" -eq 124 ]]; then
  reason="AAOS smoke timed out after ${timeout_seconds}s"
  echo "::error title=AAOS smoke::${reason}"
fi
collect_diagnostics "${reason}"
# aaosSmoke.ts writes the step table itself; when it died before writing summary.md (a crash,
# or the timeout above), add a line so the job summary still says why.
if [[ "${status}" -ne 0 && ! -f "${out_dir}/summary.md" ]]; then
  append_step_summary $'## AAOS emulator smoke (advisory)\n\n**Failed**: '"${reason}"$' before the smoke wrote its summary\n'
fi

echo "AAOS smoke exit status: ${status} (advisory)"
exit "${status}"
