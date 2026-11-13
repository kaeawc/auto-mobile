#!/usr/bin/env bash
# Shared by the advisory emulator smoke runners: give avdmanager and the emulator one AVD
# directory. Older cmdline-tools avdmanager builds put `.android` under $XDG_CONFIG_HOME when it
# is set (GitHub's Ubuntu runners set it), while `emulator -list-avds` reads $HOME/.android, so
# an AVD that startDevice createIfMissing had just created was reported as not found. Both tools
# honour ANDROID_AVD_HOME. Callers run with `set -euo pipefail`.

# Export ANDROID_AVD_HOME (an existing value wins; otherwise ANDROID_USER_HOME/avd, then
# $HOME/.android/avd) and create the directory.
pin_avd_home() {
  if [[ -z "${ANDROID_AVD_HOME:-}" ]]; then
    ANDROID_AVD_HOME="${ANDROID_USER_HOME:-${HOME}/.android}/avd"
  fi
  export ANDROID_AVD_HOME
  mkdir -p "${ANDROID_AVD_HOME}"
}

# record_avd_homes <file>: list the AVDs in ANDROID_AVD_HOME and in the legacy XDG location, so
# an artifact shows where avdmanager wrote an AVD. Best-effort; never fails the caller.
record_avd_homes() {
  local file="$1" dir
  [[ -d "$(dirname "${file}")" ]] || return 0
  {
    for dir in "${ANDROID_AVD_HOME:-}" "${XDG_CONFIG_HOME:+${XDG_CONFIG_HOME}/.android/avd}"; do
      [[ -n "${dir}" ]] || continue
      printf '%s:\n' "${dir}"
      ls -1 "${dir}" 2> /dev/null || printf '  (missing)\n'
    done
  } > "${file}" 2>&1 || true
}
