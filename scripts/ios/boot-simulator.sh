#!/usr/bin/env bash
# Thin adapter for AutoMobile's product boot flow. GitHub Actions alone gets
# the CI-owned erase-on-final-retry policy; local callers get a normal boot.
set -euo pipefail

DEFAULT_TIMEOUT_MS=300000
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
ios_version=""
timeout_ms="${DEFAULT_TIMEOUT_MS}"
ci_extra=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ios-version) ios_version="$2"; shift 2 ;;
    --timeout-ms) timeout_ms="$2"; shift 2 ;;
    --max-attempts)
      if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
        echo "error: --max-attempts is only supported by GitHub Actions CI" >&2
        exit 1
      fi
      ci_extra=("--max-attempts" "$2")
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ "${GITHUB_ACTIONS:-}" == "true" && "${CI:-}" == "true" ]]; then
  ci_args=(--timeout-ms "${timeout_ms}")
  if [[ -n "${ios_version}" ]]; then
    ci_args+=(--ios-version "${ios_version}")
  fi
  ci_args+=("${ci_extra[@]}")
  result="$(cd "${repo_root}" && bun run src/ci/bootIosSimulatorCli.ts "${ci_args[@]}")"
else
  if [[ -z "${ios_version}" ]]; then
    ios_version="$(xcrun --sdk iphonesimulator --show-sdk-version 2>/dev/null)"
    if [[ -z "${ios_version}" ]]; then
      echo "error: could not detect the active iOS Simulator SDK version" >&2
      exit 1
    fi
  fi
  boot_args=(--boot-device --platform ios --create-if-missing --timeout-ms "${timeout_ms}")
  # Existing images must match the active SDK; provisioning still delegates its
  # exact/major.minor/major runtime fallback to SimCtlClient.
  boot_args+=(--min-os-version "${ios_version}" --max-os-version "${ios_version}")
  result="$(cd "${repo_root}" && bun run src/index.ts "${boot_args[@]}")"
fi

udid="$(printf '%s' "${result}" | jq -r '.deviceId')"
if [[ -z "${udid}" || "${udid}" == "null" ]]; then
  echo "error: AutoMobile iOS boot returned no deviceId" >&2
  exit 1
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "simulator_udid=${udid}" >> "${GITHUB_OUTPUT}"
fi
echo "${udid}"
