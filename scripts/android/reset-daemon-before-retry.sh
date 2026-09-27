#!/usr/bin/env bash
# Release the CI daemon's device assignment before an emulator test retry.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="${GITHUB_WORKSPACE:-$(cd -- "${script_dir}/../.." && pwd)}"
bun_bin_dir="${HOME}/.bun/bin"
dist_entry="${repo_root}/dist/src/index.js"

# shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
source "${script_dir}/../ios/run_with_timeout.sh"

export PATH="${bun_bin_dir}:${PATH}"
hash -r 2> /dev/null || true

if ! command -v auto-mobile > /dev/null 2>&1 && [[ -x "${dist_entry}" ]]; then
  echo "auto-mobile not resolvable from global install; linking ${bun_bin_dir}/auto-mobile -> ${dist_entry}"
  if ! mkdir -p "${bun_bin_dir}" || ! ln -sf "${dist_entry}" "${bun_bin_dir}/auto-mobile"; then
    echo "Daemon reset errored: could not link the built AutoMobile CLI. Continuing with retry."
    exit 0
  fi
  hash -r 2> /dev/null || true
fi

if ! command -v auto-mobile > /dev/null 2>&1; then
  echo "Daemon reset errored: AutoMobile CLI is unavailable. Continuing with retry."
  exit 0
fi

set +e
stop_output="$(run_with_timeout 20 auto-mobile --daemon stop 2>&1)"
stop_status=$?
set -e
if [[ -n "${stop_output}" ]]; then
  printf '%s\n' "${stop_output}"
fi

if [[ "${stop_status}" -eq 124 ]]; then
  echo "Daemon reset timed out after 20 seconds. Continuing with retry."
elif [[ "${stop_status}" -ne 0 ]]; then
  echo "Daemon reset errored (exit ${stop_status}). Continuing with retry."
elif [[ "${stop_output}" == *"Daemon is not running"* ]]; then
  echo "Daemon already stopped. Continuing with retry."
else
  echo "Daemon stopped successfully. Continuing with retry."
fi

exit 0
