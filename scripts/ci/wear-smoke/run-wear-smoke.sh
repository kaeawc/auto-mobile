#!/usr/bin/env bash
# Advisory Wear OS emulator smoke (#16829): install an x86_64 Wear OS image, create a round watch
# AVD (until startDevice can create one, #16823), build the Wear fixture app (#16828) when its
# module exists, run scripts/ci/wear-smoke/wearSmoke.ts, then capture emulator diagnostics
# whatever the outcome. Exits with the smoke's status. A setup failure also collects diagnostics
# and adds a failure line to $GITHUB_STEP_SUMMARY through the EXIT trap.
#
# Env:
#   WEAR_SMOKE_OUT_DIR          artifact directory (default: scratch/wear-smoke)
#   WEAR_SMOKE_SYSTEM_IMAGE     sdkmanager package (default: API 37.0 android-wear-signed x86_64)
#   WEAR_SMOKE_DEVICE_PROFILE   avdmanager profile (default: wearos_small_round)
#   WEAR_SMOKE_AVD_NAME         AVD the runner creates (default: automobile-wear-smoke)
#   WEAR_SMOKE_CREATE_VIA       avdmanager (default) creates the AVD here; startDevice leaves it
#                               to startDevice createIfMissing (needs #16823)
#   WEAR_SMOKE_OS_VERSION       Android version startDevice is pinned to with startDevice
#                               creation (default: 17)
#   WEAR_SMOKE_FIXTURE_MODULE   Gradle module of the fixture app under android/ (default:
#                               wear-fixture); when its directory is absent the fixture steps
#                               are skipped with a warning
#   WEAR_SMOKE_FIXTURE_APK      prebuilt fixture APK; skips the Gradle build
#   WEAR_SMOKE_TIMEOUT_SECONDS  wall-clock bound for the smoke run (default: 1800)
#   WEAR_SMOKE_SDKMANAGER_TIMEOUT_SECONDS bound for each sdkmanager call (default: 900)
#   WEAR_SMOKE_BUILD_TIMEOUT_SECONDS bound for the fixture build (default: 1200)
#   WEAR_SMOKE_BREAK_ASSERTION  1 swaps in an impossible assertion (proves failures are readable)
#   WEAR_SMOKE_SKIP_IMAGE_INSTALL 1 skips sdkmanager and avdmanager (AVD already exists)
#   WEAR_SMOKE_DIAGNOSTICS_SCRIPT diagnostics collector (default:
#                               scripts/android/collect-emulator-diagnostics.sh; tests stub it)
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../../.." && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh
source "${project_root}/scripts/ios/run_with_timeout.sh"
# shellcheck source=scripts/ci/emulator-smoke/install-system-image.sh
source "${project_root}/scripts/ci/emulator-smoke/install-system-image.sh"

if [[ $# -ne 0 ]]; then
  echo "usage: run-wear-smoke.sh (no arguments; configure with WEAR_SMOKE_* env)" >&2
  exit 2
fi

out_dir="${WEAR_SMOKE_OUT_DIR:-${project_root}/scratch/wear-smoke}"
diagnostics_script="${WEAR_SMOKE_DIAGNOSTICS_SCRIPT:-${project_root}/scripts/android/collect-emulator-diagnostics.sh}"
# What the run is doing, named in the failure line when setup exits early.
phase="validating WEAR_SMOKE_* settings"
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
    local reason="Wear smoke setup failed while ${phase} (exit ${status})"
    echo "::error title=Wear smoke::${reason}"
    collect_diagnostics "${reason}"
    append_step_summary $'## Wear OS emulator smoke (advisory)\n\n**Failed** during setup: '"${reason}"$'\n'
  fi
}
trap on_exit EXIT

system_image="${WEAR_SMOKE_SYSTEM_IMAGE:-system-images;android-37.0;android-wear-signed;x86_64}"
device_profile="${WEAR_SMOKE_DEVICE_PROFILE:-wearos_small_round}"
avd_name="${WEAR_SMOKE_AVD_NAME:-automobile-wear-smoke}"
create_via="${WEAR_SMOKE_CREATE_VIA:-avdmanager}"
os_version="${WEAR_SMOKE_OS_VERSION:-17}"
fixture_module="${WEAR_SMOKE_FIXTURE_MODULE:-wear-fixture}"
fixture_apk="${WEAR_SMOKE_FIXTURE_APK:-}"
timeout_seconds="${WEAR_SMOKE_TIMEOUT_SECONDS:-1800}"
sdkmanager_timeout_seconds="${WEAR_SMOKE_SDKMANAGER_TIMEOUT_SECONDS:-900}"
build_timeout_seconds="${WEAR_SMOKE_BUILD_TIMEOUT_SECONDS:-1200}"
for setting in WEAR_SMOKE_TIMEOUT_SECONDS:"${timeout_seconds}" \
  WEAR_SMOKE_SDKMANAGER_TIMEOUT_SECONDS:"${sdkmanager_timeout_seconds}" \
  WEAR_SMOKE_BUILD_TIMEOUT_SECONDS:"${build_timeout_seconds}"; do
  if [[ ! "${setting#*:}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${setting%%:*} must be a positive integer" >&2
    exit 2
  fi
done
# Only Wear tags: a phone image would boot and silently satisfy the run with a phone.
if [[ ! "${system_image}" =~ ^system-images\;android-[0-9][0-9.]*(-ext[0-9]+)?\;android-wear(-signed|-cn)?\;[a-z0-9_-]+$ ]]; then
  echo "WEAR_SMOKE_SYSTEM_IMAGE must be an android-wear system image: ${system_image}" >&2
  exit 2
fi
case "${create_via}" in
  avdmanager | startDevice) ;;
  *)
    echo "WEAR_SMOKE_CREATE_VIA must be avdmanager or startDevice: ${create_via}" >&2
    exit 2
    ;;
esac
if [[ ! "${avd_name}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "WEAR_SMOKE_AVD_NAME may only use letters, digits, '.', '_' and '-': ${avd_name}" >&2
  exit 2
fi
if [[ ! "${fixture_module}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "WEAR_SMOKE_FIXTURE_MODULE must be a top-level module name under android/: ${fixture_module}" >&2
  exit 2
fi
phase="creating ${out_dir}"
mkdir -p "${out_dir}"

if [[ "${WEAR_SMOKE_SKIP_IMAGE_INSTALL:-0}" != "1" ]]; then
  phase="locating sdkmanager"
  sdkmanager="$(locate_sdkmanager)"
  phase="installing ${system_image}"
  install_system_image "Wear smoke" "${sdkmanager}" "${sdkmanager_timeout_seconds}" \
    "${system_image}" "${out_dir}"
  if [[ "${create_via}" == "avdmanager" ]]; then
    phase="creating the ${avd_name} AVD"
    avdmanager="$(dirname "${sdkmanager}")/avdmanager"
    # `no` declines the custom hardware profile prompt; --force replaces a stale AVD of that name.
    echo no | "${avdmanager}" create avd --force --name "${avd_name}" \
      --package "${system_image}" --device "${device_profile}" \
      > "${out_dir}/avdmanager-create.log" 2>&1
  fi
fi

fixture_note=""
if [[ -z "${fixture_apk}" ]]; then
  module_dir="${project_root}/android/${fixture_module}"
  if [[ -d "${module_dir}" ]]; then
    phase="building the ${fixture_module} fixture"
    set +e
    (cd "${project_root}/android" && run_with_timeout "${build_timeout_seconds}" \
      ./gradlew --no-daemon ":${fixture_module}:assembleDebug") > "${out_dir}/fixture-build.log" 2>&1
    build_status=$?
    set -e
    if [[ "${build_status}" -ne 0 ]]; then
      tail -n 50 "${out_dir}/fixture-build.log" >&2 || true
      exit "${build_status}"
    fi
    fixture_apk="$(find "${module_dir}/build/outputs/apk/debug" -name '*.apk' -type f 2> /dev/null | sort | head -n 1)"
    if [[ -z "${fixture_apk}" ]]; then
      echo "the ${fixture_module} build produced no debug APK" >&2
      exit 1
    fi
  else
    fixture_note="android/${fixture_module} does not exist yet (#16828); fixture steps are skipped"
    echo "::warning title=Wear smoke::${fixture_note}"
  fi
elif [[ ! -f "${fixture_apk}" ]]; then
  echo "WEAR_SMOKE_FIXTURE_APK does not exist: ${fixture_apk}" >&2
  exit 2
fi

# A run-private database keeps the watch's records off any other host state.
export AUTOMOBILE_DB_PATH="${out_dir}/db/auto-mobile.db"
mkdir -p "$(dirname "${AUTOMOBILE_DB_PATH}")"

phase="running the smoke"
export WEAR_SMOKE_OUT_DIR="${out_dir}"
export WEAR_SMOKE_FIXTURE_APK="${fixture_apk}"
export WEAR_SMOKE_OS_VERSION="${os_version}"
if [[ "${create_via}" == "avdmanager" ]]; then
  export WEAR_SMOKE_AVD_NAME="${avd_name}"
else
  export WEAR_SMOKE_AVD_NAME=""
fi
# A summary left by an earlier run in the same directory would hide a crash below.
rm -f "${out_dir}/summary.md"
# pipefail makes the pipeline report the smoke's own status (124 on timeout). set -e is
# lifted around the call rather than using `|| status=$?`, which would disable it inside
# run_with_timeout (SC2310).
set +e
run_with_timeout "${timeout_seconds}" bun "${script_dir}/wearSmoke.ts" 2>&1 \
  | tee "${out_dir}/smoke.log"
status=$?
set -e

reason="Wear smoke exited ${status}"
if [[ "${status}" -eq 124 ]]; then
  reason="Wear smoke timed out after ${timeout_seconds}s"
  echo "::error title=Wear smoke::${reason}"
fi
collect_diagnostics "${reason}"
# wearSmoke.ts writes the step table itself; when it died before writing summary.md (a crash,
# or the timeout above), add a line so the job summary still says why.
if [[ "${status}" -ne 0 && ! -f "${out_dir}/summary.md" ]]; then
  append_step_summary $'## Wear OS emulator smoke (advisory)\n\n**Failed**: '"${reason}"$' before the smoke wrote its summary\n'
fi

echo "Wear smoke exit status: ${status}${fixture_note:+ (${fixture_note})} (advisory)"
exit "${status}"
