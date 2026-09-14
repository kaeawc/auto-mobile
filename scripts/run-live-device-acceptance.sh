#!/usr/bin/env bash
# Run the explicitly opt-in issue #7144 acceptance matrix against test-owned devices.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
source "${SCRIPT_DIR}/ios/run_with_timeout.sh"

android_avd_name=""
android_runtime=""
android_device_type=""
android_memory_mb=""
android_cpu_cores=""
android_min_os_version=""
android_max_os_version=""
ios_simulator_name=""
ios_simulator_uuid=""
ios_runtime=""
ios_device_type=""
ios_min_os_version=""
ios_max_os_version=""
evidence_dir="${REPO_ROOT}/scratch/live-device-acceptance"
total_timeout_seconds=1200
platform_timeout_seconds=540
termination_grace_seconds=2
scenario="full"
confirm_live=false
test_owned_devices=false
dry_run=false

usage() {
  cat <<'EOF'
Usage:
  AUTOMOBILE_ACCEPTANCE_LIVE=1 bash scripts/run-live-device-acceptance.sh \
    --confirm-live --test-owned-devices \
    --android-avd-name <dedicated-avd> --android-runtime <system-image> --android-device-type <profile> \
    --android-memory-mb <memory-mb> --android-cpu-cores <cpu-cores> \
    --android-min-os-version <minimum-os> --android-max-os-version <maximum-os> \
    --ios-simulator-name <dedicated-simulator-name> --ios-simulator-uuid <dedicated-simulator-uuid> \
    --ios-runtime <runtime> --ios-device-type <device-type> \
    --ios-min-os-version <minimum-os> --ios-max-os-version <maximum-os> \
    [--scenario <full|recovery>] [--dry-run]

The full scenario stops, boots, provisions/adopts, repairs, restarts, and
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

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --confirm-live) confirm_live=true; shift ;;
    --test-owned-devices) test_owned_devices=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    --android-avd-name|--android-runtime|--android-device-type|--android-memory-mb|--android-cpu-cores|--android-min-os-version|--android-max-os-version|--ios-simulator-name|--ios-simulator-uuid|--ios-runtime|--ios-device-type|--ios-min-os-version|--ios-max-os-version|--evidence-dir|--total-timeout-seconds|--platform-timeout-seconds|--scenario)
      require_value "$1" "${2:-}"
      case "$1" in
        --android-avd-name) android_avd_name="$2" ;;
        --android-runtime) android_runtime="$2" ;;
        --android-device-type) android_device_type="$2" ;;
        --android-memory-mb) android_memory_mb="$2" ;;
        --android-cpu-cores) android_cpu_cores="$2" ;;
        --android-min-os-version) android_min_os_version="$2" ;;
        --android-max-os-version) android_max_os_version="$2" ;;
        --ios-simulator-name) ios_simulator_name="$2" ;;
        --ios-simulator-uuid) ios_simulator_uuid="$2" ;;
        --ios-runtime) ios_runtime="$2" ;;
        --ios-device-type) ios_device_type="$2" ;;
        --ios-min-os-version) ios_min_os_version="$2" ;;
        --ios-max-os-version) ios_max_os_version="$2" ;;
        --evidence-dir) evidence_dir="$2" ;;
        --total-timeout-seconds) total_timeout_seconds="$2" ;;
        --platform-timeout-seconds) platform_timeout_seconds="$2" ;;
        --scenario) scenario="$2" ;;
      esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

require_positive_integer "--total-timeout-seconds" "${total_timeout_seconds}"
require_positive_integer "--platform-timeout-seconds" "${platform_timeout_seconds}"
require_positive_integer "--android-memory-mb" "${android_memory_mb}"
require_positive_integer "--android-cpu-cores" "${android_cpu_cores}"
case "${scenario}" in full|recovery) ;; *)
  echo "error: unsupported --scenario: ${scenario}" >&2; exit 2 ;;
esac

if [[ "${dry_run}" != true && ( "${confirm_live}" != true || "${test_owned_devices}" != true || "${AUTOMOBILE_ACCEPTANCE_LIVE:-}" != "1" ) ]]; then
  echo "error: live mutation requires --confirm-live, --test-owned-devices, and AUTOMOBILE_ACCEPTANCE_LIVE=1." >&2
  exit 2
fi
for value in "${android_avd_name}" "${android_runtime}" "${android_device_type}" "${android_memory_mb}" "${android_cpu_cores}" "${android_min_os_version}" "${android_max_os_version}" "${ios_simulator_name}" "${ios_simulator_uuid}" "${ios_runtime}" "${ios_device_type}" "${ios_min_os_version}" "${ios_max_os_version}"; do
  if [[ -z "${value}" ]]; then
    echo "error: every explicit Android and iOS target, runtime, device type, and OS bound argument is required." >&2
    exit 2
  fi
done

umask 077
mkdir -p "${evidence_dir}"
started_at_seconds="${SECONDS}"

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
  )
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

run_platform android --avd-name "${android_avd_name}" "${android_runtime}" "${android_device_type}" "${android_min_os_version}" "${android_max_os_version}" \
  --android-memory-mb "${android_memory_mb}" --android-cpu-cores "${android_cpu_cores}"
run_platform ios --simulator-uuid "${ios_simulator_uuid}" "${ios_runtime}" "${ios_device_type}" "${ios_min_os_version}" "${ios_max_os_version}" \
  --simulator-name "${ios_simulator_name}"
echo "Acceptance matrix completed inside the original ${total_timeout_seconds}s wrapper deadline."
