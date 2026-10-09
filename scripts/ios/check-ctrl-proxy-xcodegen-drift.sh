#!/usr/bin/env bash
#
# Fast Validation entry for the CtrlProxy XcodeGen drift check (issue #10946).
#
# Runs `xcodegen-drift-check.sh --ctrl-proxy` only when the branch touches
# ios/control-proxy, so a hand-edited CtrlProxy.xcodeproj is caught before the
# macOS build instead of by the nightly. XcodeGen ships no Linux build, so on a
# host without the pinned XcodeGen this prints a SKIP notice and exits 0; the
# PR ios-xcode-build job runs the same drift check on macOS as the backstop.
#
# Env:
#   CTRL_PROXY_XCODEGEN_BASE_REF  base ref for the change scope (default origin/main)
#   CTRL_PROXY_XCODEGEN_FORCE=1   skip the change-scope test and always check

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/xcodegen_version.sh disable=SC1091
source "${SCRIPT_DIR}/xcodegen_version.sh"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BASE_REF="${CTRL_PROXY_XCODEGEN_BASE_REF:-origin/main}"

cd "${PROJECT_ROOT}"

ctrl_proxy_changed() {
    local merge_base
    if ! merge_base="$(git merge-base "${BASE_REF}" HEAD 2>/dev/null)"; then
        # No base to compare against: check rather than silently skip.
        return 0
    fi
    # Committed branch changes plus staged/unstaged edits.
    [ -n "$(git diff --name-only "${merge_base}" -- ios/control-proxy 2>/dev/null)" ]
}

if [ "${CTRL_PROXY_XCODEGEN_FORCE:-}" != "1" ] && ! ctrl_proxy_changed; then
    echo "SKIP: ios/control-proxy is unchanged against ${BASE_REF}"
    exit 0
fi

if [ "$(installed_xcodegen_version)" != "${XCODEGEN_VERSION}" ]; then
    echo "SKIP: XcodeGen ${XCODEGEN_VERSION} is not installed on this host (no Linux build); ios-xcode-build runs the drift check on macOS. Install: bash scripts/ios/install-xcodegen.sh"
    exit 0
fi

exec "${SCRIPT_DIR}/xcodegen-drift-check.sh" --ctrl-proxy
