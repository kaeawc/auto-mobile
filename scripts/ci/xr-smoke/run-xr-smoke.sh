#!/usr/bin/env bash
# Advisory XR headset emulator smoke (#16845): install an XR image, use a run-private database,
# and run scripts/ci/xr-smoke/xrSmoke.ts
# (which creates the AVD through startDevice createIfMissing), then capture emulator
# diagnostics whatever the outcome. Exits with the smoke's status. A setup failure (bad env,
# missing sdkmanager or failed install) also collects diagnostics and adds a
# failure line to $GITHUB_STEP_SUMMARY through the EXIT trap.
#
# Env:
#   XR_SMOKE_OUT_DIR         artifact directory (default: scratch/xr-smoke)
#   XR_SMOKE_CTRLPROXY_APK   prebuilt debug CtrlProxy APK; unset builds :control-proxy:assembleDebug
#                              and hands it to the daemon as AUTOMOBILE_CTRL_PROXY_APK_PATH
#   XR_SMOKE_GRADLEW / XR_SMOKE_BUILT_APK  gradlew and built-APK path overrides (tests stub them)
#   XR_SMOKE_BUILD_TIMEOUT_SECONDS bound for that build (default: 1200)
#   XR_SMOKE_AVD_NAME        boot this exact AVD instead of startDevice createIfMissing (optional)
#   XR_SMOKE_OS_VERSION      Android version the plan pins startDevice to (default: 14); the
#                              system image's API level must match it (14 = API 34)
#   XR_SMOKE_SYSTEM_IMAGE    sdkmanager package (default: API 34 google-xr, host ABI)
#   XR_SMOKE_SDK_CHANNEL     sdkmanager --channel for the install (default: 3, canary, where
#                              XR images are published; see src/devices/androidXrImageFamilies.ts)
#   XR_SMOKE_TIMEOUT_SECONDS wall-clock bound for the smoke run (default: 1800)
#   XR_SMOKE_SDKMANAGER_TIMEOUT_SECONDS bound for each sdkmanager call (default: 900)
#   XR_SMOKE_BREAK_ASSERTION 1 swaps in an impossible assertion (proves failures are readable)
#   XR_SMOKE_SKIP_IMAGE_INSTALL 1 skips sdkmanager (image already installed)
#   XR_SMOKE_SERVER          MCP server entry the private daemon runs from (default:
#                              dist/src/index.js, as the smoke client uses; tests stub it)
#   XR_SMOKE_DIAGNOSTICS_SCRIPT diagnostics collector (default:
#                              scripts/android/collect-emulator-diagnostics.sh; tests stub it)
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../../.." && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh
source "${project_root}/scripts/ios/run_with_timeout.sh"
# shellcheck source=scripts/ci/emulator-smoke/install-system-image.sh
source "${project_root}/scripts/ci/emulator-smoke/install-system-image.sh"

if [[ $# -ne 0 ]]; then
  echo "usage: run-xr-smoke.sh (no arguments; configure with XR_SMOKE_* env)" >&2
  exit 2
fi

out_dir="${XR_SMOKE_OUT_DIR:-${project_root}/scratch/xr-smoke}"
diagnostics_script="${XR_SMOKE_DIAGNOSTICS_SCRIPT:-${project_root}/scripts/android/collect-emulator-diagnostics.sh}"
# What the run is doing, named in the failure line when setup exits early.
phase="validating XR_SMOKE_* settings"
diagnostics_collected=0
private_daemon=0

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

# Stop the run-private daemon the smoke started; best-effort and never masks the status.
stop_private_daemon() {
  if [[ "${private_daemon}" -eq 1 ]]; then
    private_daemon=0
    run_with_timeout 60 bun "${server_entry}" --daemon stop > "${out_dir}/daemon-stop.log" 2>&1 || true
  fi
}

# shellcheck disable=SC2317,SC2329 # Invoked by the EXIT trap.
on_exit() {
  local status=$?
  stop_private_daemon
  if [[ "${status}" -ne 0 && "${diagnostics_collected}" -eq 0 ]]; then
    local reason="XR smoke setup failed while ${phase} (exit ${status})"
    echo "::error title=XR smoke::${reason}"
    collect_diagnostics "${reason}"
    append_step_summary $'## XR emulator smoke (advisory)\n\n**Failed** during setup: '"${reason}"$'\n'
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

os_version="${XR_SMOKE_OS_VERSION:-14}"
default_abi="x86_64"
if [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then default_abi="arm64-v8a"; fi
system_image="${XR_SMOKE_SYSTEM_IMAGE:-system-images;android-34;google-xr;${default_abi}}"
timeout_seconds="${XR_SMOKE_TIMEOUT_SECONDS:-1800}"
sdkmanager_timeout_seconds="${XR_SMOKE_SDKMANAGER_TIMEOUT_SECONDS:-900}"
sdk_channel="${XR_SMOKE_SDK_CHANNEL:-3}"
server_entry="${XR_SMOKE_SERVER:-${project_root}/dist/src/index.js}"
build_timeout_seconds="${XR_SMOKE_BUILD_TIMEOUT_SECONDS:-1200}"
for setting in XR_SMOKE_TIMEOUT_SECONDS:"${timeout_seconds}" \
  XR_SMOKE_SDKMANAGER_TIMEOUT_SECONDS:"${sdkmanager_timeout_seconds}" \
  XR_SMOKE_BUILD_TIMEOUT_SECONDS:"${build_timeout_seconds}"; do
  if [[ ! "${setting#*:}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${setting%%:*} must be a positive integer" >&2
    exit 2
  fi
done
if [[ ! "${sdk_channel}" =~ ^[0-3]$ ]]; then
  echo "XR_SMOKE_SDK_CHANNEL must be an sdkmanager channel 0-3: ${sdk_channel}" >&2
  exit 2
fi
if [[ "${system_image}" != *";google-xr;"* && "${system_image}" != *";android-xr-v3-playstore;"* && "${system_image}" != *";android-xr-preview-playstore;"* ]]; then
  echo "XR_SMOKE_SYSTEM_IMAGE must use a supported XR headset image tag: ${system_image}" >&2
  exit 2
fi
expected_api="$(api_level_for_os_version "${os_version}")"
if [[ -z "${expected_api}" ]]; then
  echo "XR_SMOKE_OS_VERSION must be an Android release such as 13, 14 or 15: ${os_version}" >&2
  exit 2
fi
# The platform segment is android-<api> or android-<api>-ext<n>; startDevice is pinned to
# os_version, so an image at any other API level would install and then never be used.
platform_segment="$(printf '%s' "${system_image}" | cut -d';' -f2)"
if [[ ! "${platform_segment}" =~ ^android-([0-9]+)(-ext[0-9]+)?$ ]]; then
  echo "XR_SMOKE_SYSTEM_IMAGE has no android-<api> platform segment: ${system_image}" >&2
  exit 2
fi
image_api="${BASH_REMATCH[1]}"
if [[ "${image_api}" != "${expected_api}" ]]; then
  echo "XR_SMOKE_SYSTEM_IMAGE is API ${image_api} but XR_SMOKE_OS_VERSION=${os_version} needs API ${expected_api}; set both together" >&2
  exit 2
fi
phase="creating ${out_dir}"
mkdir -p "${out_dir}"

if [[ "${XR_SMOKE_SKIP_IMAGE_INSTALL:-0}" != "1" ]]; then
  phase="locating sdkmanager"
  sdkmanager="$(locate_sdkmanager)"
  phase="installing ${system_image}"
  install_system_image "XR smoke" "${sdkmanager}" "${sdkmanager_timeout_seconds}" \
    "${system_image}" "${out_dir}" "--channel=${sdk_channel}"
fi

# The daemon installs the CtrlProxy APK on the headset; point it at a debug build of this checkout
# so the smoke exercises the XR hierarchy support in the tree rather than the released APK.
ctrl_proxy_apk="${XR_SMOKE_CTRLPROXY_APK:-}"
if [[ -z "${ctrl_proxy_apk}" ]]; then
  phase="building the debug CtrlProxy APK"
  gradlew="${XR_SMOKE_GRADLEW:-${project_root}/android/gradlew}"
  set +e
  (cd "$(dirname "${gradlew}")" && run_with_timeout "${build_timeout_seconds}" \
    "${gradlew}" --no-daemon :control-proxy:assembleDebug) > "${out_dir}/ctrlproxy-build.log" 2>&1
  build_status=$?
  set -e
  if [[ "${build_status}" -ne 0 ]]; then
    tail -n 50 "${out_dir}/ctrlproxy-build.log" >&2 || true
    exit "${build_status}"
  fi
  ctrl_proxy_apk="${XR_SMOKE_BUILT_APK:-${project_root}/android/control-proxy/build/outputs/apk/debug/control-proxy-debug.apk}"
fi
if [[ ! -f "${ctrl_proxy_apk}" ]]; then
  echo "CtrlProxy APK does not exist: ${ctrl_proxy_apk}" >&2
  exit 2
fi
export AUTOMOBILE_CTRL_PROXY_APK_PATH="${ctrl_proxy_apk}"

# A run-private database keeps the created AVD records off any other host state.
export AUTOMOBILE_DB_PATH="${out_dir}/db/auto-mobile.db"
mkdir -p "$(dirname "${AUTOMOBILE_DB_PATH}")"
# The database alone does not isolate the run: the daemon namespace comes from the auxiliary
# socket directory, so without one the smoke would join a resident daemon (its database and
# CtrlProxy APK). Run a private, harness-marked daemon and stop it when the script exits.
export AUTOMOBILE_AUX_SOCKET_DIR="${out_dir}/daemon"
export AUTOMOBILE_HARNESS_PRIVATE_DAEMON=1
mkdir -p "${AUTOMOBILE_AUX_SOCKET_DIR}"

phase="running the smoke"
export XR_SMOKE_OUT_DIR="${out_dir}"
export XR_SMOKE_OS_VERSION="${os_version}"
# A summary left by an earlier run in the same directory would hide a crash below.
rm -f "${out_dir}/summary.md"
# pipefail makes the pipeline report the smoke's own status (124 on timeout). set -e is
# lifted around the call rather than using `|| status=$?`, which would disable it inside
# run_with_timeout (SC2310).
private_daemon=1
set +e
run_with_timeout "${timeout_seconds}" bun "${script_dir}/xrSmoke.ts" 2>&1 \
  | tee "${out_dir}/smoke.log"
status=$?
set -e
stop_private_daemon

reason="XR smoke exited ${status}"
if [[ "${status}" -eq 124 ]]; then
  reason="XR smoke timed out after ${timeout_seconds}s"
  echo "::error title=XR smoke::${reason}"
fi
collect_diagnostics "${reason}"
# xrSmoke.ts writes the step table itself; when it died before writing summary.md (a crash,
# or the timeout above), add a line so the job summary still says why.
if [[ "${status}" -ne 0 && ! -f "${out_dir}/summary.md" ]]; then
  append_step_summary $'## XR emulator smoke (advisory)\n\n**Failed**: '"${reason}"$' before the smoke wrote its summary\n'
fi

echo "XR smoke exit status: ${status} (advisory)"
exit "${status}"
