#!/usr/bin/env bash
# Make the Android emulator binary resolvable to the AutoMobile product boot flow.
#
# `reactivecircus/android-emulator-runner` is the step that installs the SDK
# `emulator` package and exports ANDROID_HOME/PATH, and it only runs in this
# repo on an AVD cache MISS. On a cache HIT that step is skipped, so a plain
# `run:` step that calls scripts/android/boot-emulator.sh sees an SDK with no
# emulator/ directory and listAvds fails with ENOENT (issue #4237).
#
# This script is the precondition for every emulator launch that happens outside
# the third-party action: it resolves the SDK root, installs the `emulator`
# package when it is absent, and publishes ANDROID_HOME / ANDROID_SDK_ROOT /
# PATH to later steps via GITHUB_ENV and GITHUB_PATH.
set -euo pipefail

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${ANDROID_SDK_HOME:-}}}"
if [[ -z "${sdk_root}" ]]; then
  for candidate in "/usr/local/lib/android/sdk" "${HOME:-}/Library/Android/sdk" "${HOME:-}/Android/Sdk"; do
    if [[ -n "${candidate}" && -d "${candidate}" ]]; then
      sdk_root="${candidate}"
      break
    fi
  done
fi

if [[ -z "${sdk_root}" ]]; then
  echo "error: could not resolve an Android SDK root." >&2
  echo "  ANDROID_HOME=${ANDROID_HOME:-<unset>}" >&2
  echo "  ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-<unset>}" >&2
  echo "  PATH=${PATH}" >&2
  exit 1
fi

emulator_bin="${sdk_root}/emulator/emulator"

if [[ ! -x "${emulator_bin}" ]]; then
  sdkmanager=""
  for candidate in \
    "${sdk_root}/cmdline-tools/latest/bin/sdkmanager" \
    "${sdk_root}/cmdline-tools/bin/sdkmanager" \
    "${sdk_root}/tools/bin/sdkmanager"; do
    if [[ -x "${candidate}" ]]; then
      sdkmanager="${candidate}"
      break
    fi
  done

  if [[ -z "${sdkmanager}" ]]; then
    echo "error: Android emulator package is missing and no sdkmanager was found to install it." >&2
    echo "  resolved ANDROID_HOME=${sdk_root}" >&2
    echo "  expected emulator binary=${emulator_bin}" >&2
    echo "  PATH=${PATH}" >&2
    exit 1
  fi

  echo "Android emulator package missing at ${emulator_bin}; installing via ${sdkmanager}"
  yes 2>/dev/null | "${sdkmanager}" --install "emulator" >/dev/null || true
fi

if [[ ! -x "${emulator_bin}" ]]; then
  echo "error: Android emulator binary still not executable after install attempt." >&2
  echo "  resolved ANDROID_HOME=${sdk_root}" >&2
  echo "  expected emulator binary=${emulator_bin}" >&2
  echo "  PATH=${PATH}" >&2
  exit 1
fi

echo "Resolved ANDROID_HOME=${sdk_root}"
echo "Resolved emulator=${emulator_bin}"

export ANDROID_HOME="${sdk_root}"
export ANDROID_SDK_ROOT="${sdk_root}"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "ANDROID_HOME=${sdk_root}"
    echo "ANDROID_SDK_ROOT=${sdk_root}"
  } >> "${GITHUB_ENV}"
fi

if [[ -n "${GITHUB_PATH:-}" ]]; then
  {
    echo "${sdk_root}/emulator"
    echo "${sdk_root}/platform-tools"
  } >> "${GITHUB_PATH}"
fi
