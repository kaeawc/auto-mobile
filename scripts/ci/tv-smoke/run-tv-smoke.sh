#!/usr/bin/env bash
# Advisory Android TV emulator smoke (#16732): install a TV image, let startDevice create the TV
# AVD unless TV_SMOKE_CREATE_VIA=avdmanager, build the TV fixture when present, run tvSmoke.ts,
# then collect emulator diagnostics regardless of the outcome.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../../.." && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh
source "${project_root}/scripts/ios/run_with_timeout.sh"
# shellcheck source=scripts/ci/emulator-smoke/install-system-image.sh
source "${project_root}/scripts/ci/emulator-smoke/install-system-image.sh"

if [[ $# -ne 0 ]]; then
  echo "usage: run-tv-smoke.sh (no arguments; configure with TV_SMOKE_* env)" >&2
  exit 2
fi

out_dir="${TV_SMOKE_OUT_DIR:-${project_root}/scratch/tv-smoke}"
diagnostics_script="${TV_SMOKE_DIAGNOSTICS_SCRIPT:-${project_root}/scripts/android/collect-emulator-diagnostics.sh}"
phase="validating TV_SMOKE_* settings"
diagnostics_collected=0

collect_diagnostics() {
  diagnostics_collected=1
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
    local reason="TV smoke setup failed while ${phase} (exit ${status})"
    echo "::error title=TV smoke::${reason}"
    collect_diagnostics "${reason}"
    append_step_summary $'## Android TV emulator smoke (advisory)\n\n**Failed** during setup: '"${reason}"$'\n'
  fi
}
trap on_exit EXIT

system_image="${TV_SMOKE_SYSTEM_IMAGE:-system-images;android-36;android-tv;x86_64}"
device_profile="${TV_SMOKE_DEVICE_PROFILE:-tv_1080p}"
avd_name="${TV_SMOKE_AVD_NAME:-automobile-tv-smoke}"
create_via="${TV_SMOKE_CREATE_VIA:-startDevice}"
os_version="${TV_SMOKE_OS_VERSION:-}"
fixture_module="${TV_SMOKE_FIXTURE_MODULE:-tv-fixture}"
fixture_apk="${TV_SMOKE_FIXTURE_APK:-}"
timeout_seconds="${TV_SMOKE_TIMEOUT_SECONDS:-1800}"
sdkmanager_timeout_seconds="${TV_SMOKE_SDKMANAGER_TIMEOUT_SECONDS:-900}"
build_timeout_seconds="${TV_SMOKE_BUILD_TIMEOUT_SECONDS:-1200}"
for setting in TV_SMOKE_TIMEOUT_SECONDS:"${timeout_seconds}" \
  TV_SMOKE_SDKMANAGER_TIMEOUT_SECONDS:"${sdkmanager_timeout_seconds}" \
  TV_SMOKE_BUILD_TIMEOUT_SECONDS:"${build_timeout_seconds}"; do
  if [[ ! "${setting#*:}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${setting%%:*} must be a positive integer" >&2
    exit 2
  fi
done
if [[ ! "${system_image}" =~ ^system-images\;android-[0-9][0-9.]*(-ext[0-9]+)?\;((android-tv)|(google-tv))\;[a-z0-9_-]+$ ]]; then
  echo "TV_SMOKE_SYSTEM_IMAGE must be an android-tv or google-tv system image: ${system_image}" >&2
  exit 2
fi
# startDevice is pinned to os_version, so it must name the release the image's API level ships
# as (12 = 31, 12L = 32, then 13 = 33 onward); otherwise the installed image is never used.
image_api="$(printf '%s' "${system_image}" | cut -d';' -f2 | sed -E 's/^android-([0-9]+).*/\1/')"
case "${image_api}" in
  31) image_os_version=12 ;;
  32) image_os_version=12L ;;
  *) image_os_version=$((image_api >= 33 ? image_api - 20 : 0)) ;;
esac
if [[ "${image_os_version}" == "0" ]]; then
  echo "TV_SMOKE_SYSTEM_IMAGE must be API 31 or newer: ${system_image}" >&2
  exit 2
fi
if [[ -z "${os_version}" ]]; then
  os_version="${image_os_version}"
elif [[ "${os_version}" != "${image_os_version}" ]]; then
  echo "TV_SMOKE_SYSTEM_IMAGE is API ${image_api} (Android ${image_os_version}) but TV_SMOKE_OS_VERSION=${os_version}; set both together" >&2
  exit 2
fi
case "${create_via}" in
  startDevice | avdmanager) ;;
  *)
    echo "TV_SMOKE_CREATE_VIA must be startDevice or avdmanager: ${create_via}" >&2
    exit 2
    ;;
esac
if [[ ! "${avd_name}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "TV_SMOKE_AVD_NAME may only use letters, digits, '.', '_' and '-': ${avd_name}" >&2
  exit 2
fi
if [[ ! "${fixture_module}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "TV_SMOKE_FIXTURE_MODULE must be a top-level module name under android/: ${fixture_module}" >&2
  exit 2
fi
phase="creating ${out_dir}"
mkdir -p "${out_dir}"

skip_image_install="${TV_SMOKE_SKIP_IMAGE_INSTALL:-0}"
if [[ "${skip_image_install}" != "1" || "${create_via}" == "avdmanager" ]]; then
  phase="locating sdkmanager"
  sdkmanager="$(locate_sdkmanager)"
fi
if [[ "${skip_image_install}" != "1" ]]; then
  phase="installing ${system_image}"
  install_system_image "TV smoke" "${sdkmanager}" "${sdkmanager_timeout_seconds}" \
    "${system_image}" "${out_dir}"
fi
# The named AVD is created even when the image install is skipped: startDevice boots it by name.
if [[ "${create_via}" == "avdmanager" ]]; then
  phase="creating the ${avd_name} AVD"
  avdmanager="$(dirname "${sdkmanager}")/avdmanager"
  echo no | "${avdmanager}" create avd --force --name "${avd_name}" \
    --package "${system_image}" --device "${device_profile}" \
    > "${out_dir}/avdmanager-create.log" 2>&1
fi

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
    echo "::error title=TV smoke::android/${fixture_module} does not exist"
    exit 1
  fi
elif [[ ! -f "${fixture_apk}" ]]; then
  echo "TV_SMOKE_FIXTURE_APK does not exist: ${fixture_apk}" >&2
  exit 2
fi

export AUTOMOBILE_DB_PATH="${out_dir}/db/auto-mobile.db"
mkdir -p "$(dirname "${AUTOMOBILE_DB_PATH}")"
phase="running the smoke"
export TV_SMOKE_OUT_DIR="${out_dir}"
export TV_SMOKE_FIXTURE_APK="${fixture_apk}"
export TV_SMOKE_OS_VERSION="${os_version}"
if [[ "${create_via}" == "avdmanager" ]]; then
  export TV_SMOKE_AVD_NAME="${avd_name}"
else
  export TV_SMOKE_AVD_NAME=""
fi
rm -f "${out_dir}/summary.md"
set +e
run_with_timeout "${timeout_seconds}" bun "${script_dir}/tvSmoke.ts" 2>&1 \
  | tee "${out_dir}/smoke.log"
status=$?
set -e

reason="TV smoke exited ${status}"
if [[ "${status}" -eq 124 ]]; then
  reason="TV smoke timed out after ${timeout_seconds}s"
  echo "::error title=TV smoke::${reason}"
fi
collect_diagnostics "${reason}"
if [[ "${status}" -ne 0 && ! -f "${out_dir}/summary.md" ]]; then
  append_step_summary $'## Android TV emulator smoke (advisory)\n\n**Failed**: '"${reason}"$' before the smoke wrote its summary\n'
fi
echo "TV smoke exit status: ${status} (advisory)"
exit "${status}"
