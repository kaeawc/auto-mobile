#!/usr/bin/env bash
#
# Single source of truth for the Xcode version CI and the local build scripts use.
# Sourced (not executed), like scripts/ios/xcodegen_version.sh.
#
# CI selects this version per job: hosted jobs through maxim-lobanov/setup-xcode,
# self-hosted Mac jobs through scripts/ci/select-self-hosted-xcode.sh, which
# exports DEVELOPER_DIR for that job only. Neither path runs `sudo xcode-select`,
# so the machine-wide default Xcode is never changed. test/bats/xcode-version-pin.bats
# fails when a workflow selects a different version for a job that follows the pin.
#
# Local scripts call select_pinned_xcode, which exports DEVELOPER_DIR for the
# pinned Xcode when it is installed and nothing chose a toolchain already.

AUTOMOBILE_XCODE_VERSION="27.2"

# Exports DEVELOPER_DIR for the pinned Xcode, unless:
#   - DEVELOPER_DIR is already set (the caller or the CI step chose a toolchain), or
#   - the active Xcode already is the pinned version, or
#   - the pinned Xcode is not installed (prints a note and keeps the active Xcode).
# Always succeeds, so callers under `set -e` need no `|| true`.
select_pinned_xcode() {
  if [[ -n "${DEVELOPER_DIR:-}" ]]; then
    return 0
  fi
  if ! command -v xcode-select > /dev/null 2>&1 || ! command -v plutil > /dev/null 2>&1; then
    return 0
  fi
  # Read the active version from the selected bundle's version.plist rather than
  # running xcodebuild, which is slow on a cold start and stubbed by shell tests.
  local active="" active_dir=""
  active_dir="$(xcode-select -p 2> /dev/null)" || active_dir=""
  if [[ -n "${active_dir}" && -f "${active_dir}/../version.plist" ]]; then
    active="$(plutil -extract CFBundleShortVersionString raw -o - "${active_dir}/../version.plist" 2> /dev/null)" || active=""
  fi
  if [[ "${active}" == "${AUTOMOBILE_XCODE_VERSION}" || "${active}" == "${AUTOMOBILE_XCODE_VERSION}.0" ]]; then
    return 0
  fi
  local selector developer_dir=""
  selector="$(cd "$(dirname "${BASH_SOURCE[0]}")/../ci" && pwd)/select-self-hosted-xcode.sh"
  if developer_dir="$(GITHUB_ENV="" bash "${selector}" --exact --print "${AUTOMOBILE_XCODE_VERSION}" 2> /dev/null)" \
    && [[ -n "${developer_dir}" ]]; then
    export DEVELOPER_DIR="${developer_dir}"
    echo "Using pinned Xcode ${AUTOMOBILE_XCODE_VERSION}: ${DEVELOPER_DIR} (set DEVELOPER_DIR to override)." >&2
    return 0
  fi
  echo "Pinned Xcode ${AUTOMOBILE_XCODE_VERSION} is not installed; using the active Xcode ${active:-unknown}." >&2
  return 0
}
