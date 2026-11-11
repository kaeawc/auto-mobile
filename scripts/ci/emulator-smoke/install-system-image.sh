#!/usr/bin/env bash
# Shared by the advisory emulator smoke runners (AAOS #16746, Wear OS #16829): accept the SDK
# licenses and install one system image, each sdkmanager call bounded by a timeout. Source it
# after scripts/ios/run_with_timeout.sh; callers run with `set -euo pipefail`.

# Print the sdkmanager under ANDROID_HOME/ANDROID_SDK_ROOT, or fail naming where it looked.
locate_sdkmanager() {
  local sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  local sdkmanager="${sdk_root}/cmdline-tools/latest/bin/sdkmanager"
  if [[ -z "${sdk_root}" || ! -x "${sdkmanager}" ]]; then
    echo "sdkmanager not found under ANDROID_HOME/ANDROID_SDK_ROOT (${sdk_root:-unset})" >&2
    return 1
  fi
  printf '%s\n' "${sdkmanager}"
}

# install_system_image <error-title> <sdkmanager> <timeout-seconds> <package> <log-dir> [sdkmanager-option...]
# Extra options (for example --channel=3 for canary-only images) go to both sdkmanager calls. Exits the calling script with sdkmanager's status (124 on timeout) when the install fails.
install_system_image() {
  local title="$1" sdkmanager="$2" timeout_seconds="$3" package="$4" log_dir="$5"
  shift 5
  local licenses_status install_status
  # set -e is lifted around both calls so run_with_timeout keeps it inside (SC2310). `yes` exits
  # on SIGPIPE once sdkmanager stops reading, and a licenses failure surfaces as the install
  # failing, so only a timeout of that call is fatal.
  set +e
  { yes || true; } | run_with_timeout "${timeout_seconds}" \
    "${sdkmanager}" "$@" --licenses > "${log_dir}/sdkmanager-licenses.log" 2>&1
  licenses_status=$?
  set -e
  if [[ "${licenses_status}" -eq 124 ]]; then
    echo "::error title=${title}::sdkmanager --licenses timed out after ${timeout_seconds}s"
    exit 124
  fi
  set +e
  run_with_timeout "${timeout_seconds}" \
    "${sdkmanager}" "$@" --install "${package}" > "${log_dir}/sdkmanager-install.log" 2>&1
  install_status=$?
  set -e
  if [[ "${install_status}" -ne 0 ]]; then
    tail -n 50 "${log_dir}/sdkmanager-install.log" >&2 || true
    if [[ "${install_status}" -eq 124 ]]; then
      echo "::error title=${title}::sdkmanager --install timed out after ${timeout_seconds}s"
    else
      echo "::error title=${title}::sdkmanager could not install ${package}"
    fi
    exit "${install_status}"
  fi
}
