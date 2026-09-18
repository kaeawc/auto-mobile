#!/usr/bin/env bash
# Run the explicitly opt-in issue #7144 acceptance matrix against test-owned devices.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
source "${SCRIPT_DIR}/ios/run_with_timeout.sh"

acceptance_run_token() {
  local token
  token="$(LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d '[:space:]')"
  if [[ "${#token}" -ne 64 ]]; then
    echo "error: could not generate live acceptance run capability." >&2
    return 1
  fi
  printf '%s' "${token}"
}

android_avd_name=""
android_sibling_avd_name=""
android_duplicate_serial=""
android_runtime=""
android_device_type=""
android_memory_mb=""
android_cpu_cores=""
android_min_os_version=""
android_max_os_version=""
ios_simulator_name=""
ios_simulator_uuid=""
ios_same_name_sibling_uuid=""
ios_runtime=""
ios_device_type=""
ios_min_os_version=""
ios_max_os_version=""
evidence_dir="${REPO_ROOT}/scratch/live-device-acceptance"
ownership_manifest=""
operator_key_file=""
create_operator_key=false
record_ownership_manifest=false
total_timeout_seconds=1200
platform_timeout_seconds=540
termination_grace_seconds=2
scenario="full"
confirm_live=false
test_owned_devices=false
dry_run=false

usage() {
  cat << 'EOF'
Usage:
  AUTOMOBILE_ACCEPTANCE_LIVE=1 bash scripts/run-live-device-acceptance.sh \
    --confirm-live --test-owned-devices \
    --android-avd-name <dedicated-avd> --android-runtime <system-image> --android-device-type <profile> \
    --android-sibling-avd-name <dedicated-sibling-avd> --android-duplicate-serial <controlled-duplicate-serial> \
    --android-memory-mb <memory-mb> --android-cpu-cores <cpu-cores> \
    --android-min-os-version <minimum-os> --android-max-os-version <maximum-os> \
    --ios-simulator-name <dedicated-simulator-name> --ios-simulator-uuid <dedicated-simulator-uuid> \
    --ios-same-name-sibling-uuid <dedicated-same-name-sibling-uuid> \
    --ios-runtime <runtime> --ios-device-type <device-type> \
    --ios-min-os-version <minimum-os> --ios-max-os-version <maximum-os> \
    --ownership-manifest <path> --operator-key-file <path> \
    [--create-operator-key] [--record-ownership-manifest] \
    [--scenario <full>] [--dry-run]

The full scenario stops, boots, provisions/adopts, restarts, and
reacquires only the two explicit targets. It is never PR CI. --test-owned-devices
acknowledges that both targets are dedicated, disposable test devices with no
user data or active work.
EOF
}

require_value() {
  local flag="$1" value="${2:-}"
  if [[ -z "${value}" || "${value}" == --* ]]; then
    echo "error: ${flag} requires a value." >&2
    exit 2
  fi
}

require_positive_integer() {
  if ! [[ "$2" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: $1 must be a positive integer." >&2
    exit 2
  fi
}

path_mode() {
  stat -c '%a' "$1" 2> /dev/null || stat -f '%Lp' "$1"
}

validate_private_directory() {
  local path="$1" description="$2" mode
  if [[ ! -e "${path}" ]]; then
    return
  fi
  if [[ ! -d "${path}" ]]; then
    echo "error: ${description} is not a directory: ${path}" >&2
    exit 2
  fi
  mode="$(path_mode "${path}")"
  if [[ "${mode}" != "700" ]]; then
    echo "error: ${description} must have mode 700; refusing to change existing directory mode ${mode}: ${path}" >&2
    exit 2
  fi
}

ensure_private_directory() {
  local path="$1" description="$2"
  validate_private_directory "${path}" "${description}"
  if [[ ! -e "${path}" ]]; then
    mkdir -p "${path}"
  fi
  validate_private_directory "${path}" "${description}"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --confirm-live)
      confirm_live=true
      shift
      ;;
    --test-owned-devices)
      test_owned_devices=true
      shift
      ;;
    --create-operator-key)
      create_operator_key=true
      shift
      ;;
    --record-ownership-manifest)
      record_ownership_manifest=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --android-avd-name | --android-sibling-avd-name | --android-duplicate-serial | --android-runtime | --android-device-type | --android-memory-mb | --android-cpu-cores | --android-min-os-version | --android-max-os-version | --ios-simulator-name | --ios-simulator-uuid | --ios-same-name-sibling-uuid | --ios-runtime | --ios-device-type | --ios-min-os-version | --ios-max-os-version | --evidence-dir | --ownership-manifest | --operator-key-file | --total-timeout-seconds | --platform-timeout-seconds | --scenario)
      require_value "$1" "${2:-}"
      case "$1" in
        --android-avd-name) android_avd_name="$2" ;;
        --android-sibling-avd-name) android_sibling_avd_name="$2" ;;
        --android-duplicate-serial) android_duplicate_serial="$2" ;;
        --android-runtime) android_runtime="$2" ;;
        --android-device-type) android_device_type="$2" ;;
        --android-memory-mb) android_memory_mb="$2" ;;
        --android-cpu-cores) android_cpu_cores="$2" ;;
        --android-min-os-version) android_min_os_version="$2" ;;
        --android-max-os-version) android_max_os_version="$2" ;;
        --ios-simulator-name) ios_simulator_name="$2" ;;
        --ios-simulator-uuid) ios_simulator_uuid="$2" ;;
        --ios-same-name-sibling-uuid) ios_same_name_sibling_uuid="$2" ;;
        --ios-runtime) ios_runtime="$2" ;;
        --ios-device-type) ios_device_type="$2" ;;
        --ios-min-os-version) ios_min_os_version="$2" ;;
        --ios-max-os-version) ios_max_os_version="$2" ;;
        --evidence-dir) evidence_dir="$2" ;;
        --ownership-manifest) ownership_manifest="$2" ;;
        --operator-key-file) operator_key_file="$2" ;;
        --total-timeout-seconds) total_timeout_seconds="$2" ;;
        --platform-timeout-seconds) platform_timeout_seconds="$2" ;;
        --scenario) scenario="$2" ;;
      esac
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_positive_integer "--total-timeout-seconds" "${total_timeout_seconds}"
require_positive_integer "--platform-timeout-seconds" "${platform_timeout_seconds}"
require_positive_integer "--android-memory-mb" "${android_memory_mb}"
require_positive_integer "--android-cpu-cores" "${android_cpu_cores}"
case "${scenario}" in full) ;; *)
  echo "error: unsupported --scenario: ${scenario}" >&2
  exit 2
  ;;
esac

if [[ "${dry_run}" != true && "${record_ownership_manifest}" != true && ("${confirm_live}" != true || "${test_owned_devices}" != true || "${AUTOMOBILE_ACCEPTANCE_LIVE:-}" != "1") ]]; then
  echo "error: live mutation requires --confirm-live, --test-owned-devices, and AUTOMOBILE_ACCEPTANCE_LIVE=1." >&2
  exit 2
fi
for value in "${android_avd_name}" "${android_sibling_avd_name}" "${android_duplicate_serial}" "${android_runtime}" "${android_device_type}" "${android_memory_mb}" "${android_cpu_cores}" "${android_min_os_version}" "${android_max_os_version}" "${ios_simulator_name}" "${ios_simulator_uuid}" "${ios_same_name_sibling_uuid}" "${ios_runtime}" "${ios_device_type}" "${ios_min_os_version}" "${ios_max_os_version}"; do
  if [[ -z "${value}" ]]; then
    echo "error: every explicit Android and iOS target, runtime, device type, and OS bound argument is required." >&2
    exit 2
  fi
done
if [[ "${android_avd_name}" == "${android_sibling_avd_name}" ]]; then
  echo "error: --android-sibling-avd-name must differ from --android-avd-name." >&2
  exit 2
fi
if [[ "${android_duplicate_serial}" == "${android_avd_name}" || "${android_duplicate_serial}" == "${android_sibling_avd_name}" ]]; then
  echo "error: --android-duplicate-serial must identify a live serial, not an AVD name." >&2
  exit 2
fi
if [[ "${ios_simulator_uuid}" == "${ios_same_name_sibling_uuid}" ]]; then
  echo "error: --ios-same-name-sibling-uuid must differ from --ios-simulator-uuid." >&2
  exit 2
fi

umask 077
if [[ -z "${ownership_manifest}" || -z "${operator_key_file}" ]]; then
  echo "error: --ownership-manifest and --operator-key-file are required." >&2
  exit 2
fi
validate_private_directory "${evidence_dir}" "evidence directory"
if [[ "${create_operator_key}" == true ]]; then
  if [[ -e "${operator_key_file}" ]]; then
    echo "error: refusing to overwrite existing operator key: ${operator_key_file}" >&2
    exit 2
  fi
  validate_private_directory "$(dirname -- "${operator_key_file}")" "operator key parent"
fi
ensure_private_directory "${evidence_dir}" "evidence directory"
if [[ "${create_operator_key}" == true ]]; then
  ensure_private_directory "$(dirname -- "${operator_key_file}")" "operator key parent"
  dd if=/dev/urandom of="${operator_key_file}" bs=32 count=1 status=none
  chmod 600 "${operator_key_file}"
fi
if [[ ! -f "${operator_key_file}" ]]; then
  echo "error: operator key file does not exist: ${operator_key_file}" >&2
  exit 2
fi
operator_key_mode="$(path_mode "${operator_key_file}")"
if [[ "${operator_key_mode}" != "600" ]]; then
  echo "error: operator key file must have mode 600: ${operator_key_file}" >&2
  exit 2
fi
started_at_seconds="${SECONDS}"
build_budget=$((total_timeout_seconds - termination_grace_seconds))
if [[ "${build_budget}" -le 0 ]]; then
  echo "error: --total-timeout-seconds must exceed the ${termination_grace_seconds}s termination grace." >&2
  exit 2
fi
(
  cd "${REPO_ROOT}"
  run_with_timeout "${build_budget}" bun run build
)
entrypoint="${REPO_ROOT}/dist/src/index.js"
if [[ ! -f "${entrypoint}" ]]; then
  echo "error: build did not produce ${entrypoint}" >&2
  exit 1
fi
run_platform() {
  local platform="$1" target_flag="$2" target_value="$3" runtime="$4" device_type="$5" min_os_version="$6" max_os_version="$7"
  shift 7
  local elapsed remaining max_driver_budget budget evidence_path status
  elapsed=$((SECONDS - started_at_seconds))
  remaining=$((total_timeout_seconds - elapsed))
  if [[ "${remaining}" -le 0 ]]; then
    echo "error: original total deadline (${total_timeout_seconds}s) exhausted." >&2
    return 124
  fi
  max_driver_budget=$((remaining - termination_grace_seconds))
  if [[ "${max_driver_budget}" -le 0 ]]; then
    echo "error: original total deadline (${total_timeout_seconds}s) has no time left for a driver before termination grace." >&2
    return 124
  fi
  budget=$((platform_timeout_seconds - termination_grace_seconds))
  if [[ "${budget}" -le 0 ]]; then
    echo "error: --platform-timeout-seconds must exceed the ${termination_grace_seconds}s termination grace." >&2
    return 2
  fi
  [[ "${budget}" -le "${max_driver_budget}" ]] || budget="${max_driver_budget}"
  evidence_path="${evidence_dir}/${platform}-${scenario}-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  local -a driver_args=(
    scripts/live-device-acceptance.ts --platform "${platform}" "${target_flag}" "${target_value}"
    --confirm-live --test-owned-devices
    --runtime "${runtime}" --device-type "${device_type}"
    --min-os-version "${min_os_version}" --max-os-version "${max_os_version}" --scenario "${scenario}"
    --evidence "${evidence_path}" --timeout-ms "$((budget * 1000))"
    --entrypoint "${entrypoint}" --operator-key-file "${operator_key_file}"
    --ownership-manifest "${ownership_manifest}"
    --android-sibling-avd-name "${android_sibling_avd_name}"
    --android-duplicate-serial "${android_duplicate_serial}"
    --ios-same-name-sibling-uuid "${ios_same_name_sibling_uuid}"
  )
  if [[ "${record_ownership_manifest}" == true ]]; then
    driver_args+=(--record-ownership-manifest)
  fi
  driver_args+=("$@")
  set +e
  (
    cd "${REPO_ROOT}"
    run_with_timeout "${budget}" bun "${driver_args[@]}"
  )
  status=$?
  set -e
  if [[ "${status}" -ne 0 ]]; then
    echo "error: ${platform} ${scenario} failed (evidence: ${evidence_path})." >&2
    return "${status}"
  fi
  echo "${platform} evidence: ${evidence_path}"
}

if [[ "${dry_run}" == true ]]; then
  echo "Dry run validated explicit targets and bounds; no daemon or device command was invoked."
  exit 0
fi

# These opaque values scope the entire Android+iOS matrix, rather than either
# platform invocation. They are inherited by every harness child, including a
# daemon started by Android that iOS later reuses and any admitted restart.
AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET="$(acceptance_run_token)"
AUTOMOBILE_ACCEPTANCE_DISCOVERY_CAPABILITY="$(acceptance_run_token)"
export AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET
export AUTOMOBILE_ACCEPTANCE_DISCOVERY_CAPABILITY

run_platform android --avd-name "${android_avd_name}" "${android_runtime}" "${android_device_type}" "${android_min_os_version}" "${android_max_os_version}" \
  --android-memory-mb "${android_memory_mb}" --android-cpu-cores "${android_cpu_cores}"
run_platform ios --simulator-uuid "${ios_simulator_uuid}" "${ios_runtime}" "${ios_device_type}" "${ios_min_os_version}" "${ios_max_os_version}" \
  --simulator-name "${ios_simulator_name}"
if [[ "${record_ownership_manifest}" == true ]]; then
  echo "Recorded signed ownership manifest for both dedicated targets: ${ownership_manifest}"
  exit 0
fi
echo "Acceptance matrix completed inside the original ${total_timeout_seconds}s wrapper deadline."
