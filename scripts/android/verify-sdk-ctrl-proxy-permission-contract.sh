#!/usr/bin/env bash
#
# Verifies the CtrlProxy-owned V2 signature permission with an SDK host signed by a different key.

set -euo pipefail

ctrl_proxy_apk_input="${1:?usage: verify-sdk-ctrl-proxy-permission-contract.sh <ctrl-proxy-apk>}"
ctrl_proxy_apk="$(cd "$(dirname "$ctrl_proxy_apk_input")" && pwd)/$(basename "$ctrl_proxy_apk_input")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
android_dir="${repo_root}/android"
host_apk="${android_dir}/playground/app/build/outputs/apk/debug/app-debug.apk"

adb_bin="${ADB_BIN:-adb}"
gradle_cmd="${GRADLE_CMD:-${android_dir}/gradlew}"
keytool_bin="${KEYTOOL_BIN:-keytool}"
sleep_bin="${SLEEP_BIN:-sleep}"
ctrl_proxy_package="dev.jasonpearson.automobile.ctrlproxy"
host_package="dev.jasonpearson.automobile.playground"
result_file="files/automobile-network-control-contract-result"
send_action="dev.jasonpearson.automobile.ctrlproxy.action.TEST_SEND_NETWORK_CONTROL"
probe_action="dev.jasonpearson.automobile.playground.action.TEST_PROBE_NETWORK_CONTROL"
expected_error_type="ctrlproxy-v2"

resolve_apksigner() {
  if [[ -n "${APKSIGNER_BIN:-}" ]]; then
    printf '%s\n' "$APKSIGNER_BIN"
    return
  fi

  if command -v apksigner >/dev/null 2>&1; then
    command -v apksigner
    return
  fi

  local sdk_root candidate
  for sdk_root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do
    [[ -n "$sdk_root" ]] || continue
    for candidate in "$sdk_root"/build-tools/*/apksigner; do
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return
      fi
    done
  done

  echo "error: apksigner is required to verify the distinct host signature" >&2
  return 1
}

certificate_digest() {
  "$apksigner_bin" verify --print-certs "$1" |
    awk -F ': ' '/Signer #1 certificate SHA-256 digest:/ { print $2; exit }'
}

cleanup_packages() {
  "$adb_bin" uninstall "$host_package" >/dev/null 2>&1 || true
  "$adb_bin" uninstall "$ctrl_proxy_package" >/dev/null 2>&1 || true
}

install_in_order() {
  local first_apk="$1"
  local second_apk="$2"
  cleanup_packages
  "$adb_bin" install "$first_apk" >/dev/null
  "$adb_bin" install "$second_apk" >/dev/null
}

verify_control_broadcast_delivery() {
  local installation_order="$1"

  "$adb_bin" shell am start -W -n "${host_package}/.MainActivity" >/dev/null
  "$adb_bin" shell run-as "$host_package" rm -f "$result_file"

  local attempt result
  for ((attempt = 0; attempt < 20; attempt++)); do
    # CtrlProxy has not been launched after each clean install, so its debug receiver is stopped.
    "$adb_bin" shell am broadcast --include-stopped-packages -a "$send_action" -p "$ctrl_proxy_package" >/dev/null
    "$adb_bin" shell am broadcast -a "$probe_action" -p "$host_package" >/dev/null
    result="$("$adb_bin" shell run-as "$host_package" cat "$result_file" 2>/dev/null || true)"
    if [[ "$result" == "$expected_error_type" ]]; then
      echo "verified V2 control broadcast delivery after $installation_order"
      return
    fi
    "$sleep_bin" 1
  done

  echo "error: CtrlProxy V2 control broadcast did not reach SDK host after $installation_order" >&2
  return 1
}

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/auto-mobile-sdk-host.XXXXXX")"
host_keystore="${tmp_dir}/host.keystore"
# shellcheck disable=SC2317,SC2329 # Invoked by the EXIT trap below.
cleanup() {
  unlink "$host_keystore" 2>/dev/null || true
  rmdir "$tmp_dir" 2>/dev/null || true
}
trap cleanup EXIT

[[ -f "$ctrl_proxy_apk" ]] || {
  echo "error: CtrlProxy APK not found: $ctrl_proxy_apk" >&2
  exit 1
}

"$keytool_bin" \
  -genkeypair \
  -keystore "$host_keystore" \
  -storepass contract-test \
  -keypass contract-test \
  -alias sdk-host \
  -keyalg RSA \
  -keysize 2048 \
  -validity 1 \
  -dname "CN=AutoMobile SDK Contract"

(
  cd "$android_dir"
  RELEASE_KEYSTORE_PATH="$host_keystore" \
    RELEASE_KEYSTORE_PASSWORD=contract-test \
    RELEASE_KEY_ALIAS=sdk-host \
    RELEASE_KEY_PASSWORD=contract-test \
    "$gradle_cmd" :playground:app:assembleDebug --console=plain
)

[[ -f "$host_apk" ]] || {
  echo "error: SDK host APK not found: $host_apk" >&2
  exit 1
}

apksigner_bin="$(resolve_apksigner)"
ctrl_proxy_digest="$(certificate_digest "$ctrl_proxy_apk")"
host_digest="$(certificate_digest "$host_apk")"
[[ -n "$ctrl_proxy_digest" && -n "$host_digest" ]] || {
  echo "error: could not read APK certificate digests" >&2
  exit 1
}
[[ "$ctrl_proxy_digest" != "$host_digest" ]] || {
  echo "error: CtrlProxy and SDK host must use different signing certificates" >&2
  exit 1
}

# The debug-only probe receivers require android.permission.DUMP. Restart adbd
# as root before installing either package so their broadcasts execute with it.
"$adb_bin" root >/dev/null
"$adb_bin" wait-for-device

install_in_order "$host_apk" "$ctrl_proxy_apk"
verify_control_broadcast_delivery "installing the SDK host before CtrlProxy"
install_in_order "$ctrl_proxy_apk" "$host_apk"
verify_control_broadcast_delivery "installing CtrlProxy before the SDK host"
