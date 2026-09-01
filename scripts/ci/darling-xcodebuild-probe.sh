#!/usr/bin/env bash
#
# OPTIONAL, OFF-BY-DEFAULT probe: attempt real `xcodebuild` under Darling.
#
# Darling does not — and legally cannot — ship xcodebuild. It comes only with
# Apple's Xcode or Command Line Tools, whose license agreement permits use on
# Apple-branded hardware only. Running them under Darling on a Linux CI
# runner is almost certainly outside that license. This script therefore:
#   - never downloads anything from Apple,
#   - only runs when a caller explicitly supplies their own archive URL via
#     the workflow_dispatch input (DARLING_XCODE_ARCHIVE_URL),
#   - exists for personal, at-your-own-risk experimentation, not as a step
#     toward default CI. Do not wire it into pull_request or merge workflows.
#
# Expected archive: a .tar.gz/.tar.zst/.tar.xz containing either an extracted
# Xcode.app or a Library/Developer/CommandLineTools tree. (.xip is not
# supported: extracting it requires Apple tooling we cannot assume.)
#
# Even with Xcode present, upstream reports xcodebuild as fragile under
# Darling (e.g. darlinghq/darling#1475, license-acceptance loop), so probes
# are graduated: -version, -showsdks, then -list on a real project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ARCHIVE_URL="${DARLING_XCODE_ARCHIVE_URL:-${1:-}}"
if [[ -z "${ARCHIVE_URL}" ]]; then
    echo "Usage: DARLING_XCODE_ARCHIVE_URL=<url-or-path> $0" >&2
    echo "No Xcode archive supplied; refusing to guess. See header for licensing notes." >&2
    exit 2
fi

if ! command -v darling >/dev/null 2>&1; then
    echo "Error: 'darling' is not on PATH. Run scripts/ci/darling-install.sh first." >&2
    exit 2
fi

echo "WARNING: running Apple developer tools on non-Apple hardware is restricted"
echo "by Apple's license agreements. You supplied this archive; that call is yours."

LOG_DIR="${PROJECT_ROOT}/scratch/darling"
mkdir -p "${LOG_DIR}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

archive="${WORK_DIR}/xcode-archive"
if [[ -f "${ARCHIVE_URL}" ]]; then
    archive="${ARCHIVE_URL}"
else
    echo "Downloading supplied archive..."
    curl -fL -o "${archive}" "${ARCHIVE_URL}"
fi

echo "Extracting..."
mkdir -p "${WORK_DIR}/extracted"
tar -xf "${archive}" -C "${WORK_DIR}/extracted"

# Locate a developer dir in the extracted tree.
DEVELOPER_SRC=""
DEVELOPER_DEST=""
xcode_app="$(find "${WORK_DIR}/extracted" -maxdepth 2 -type d -name "Xcode*.app" | head -n 1)"
clt_dir="$(find "${WORK_DIR}/extracted" -maxdepth 4 -type d -path "*Developer/CommandLineTools" | head -n 1)"
if [[ -n "${xcode_app}" ]]; then
    DEVELOPER_SRC="${xcode_app}"
    DEVELOPER_DEST="/Applications/Xcode.app"
    DEVELOPER_SWITCH="/Applications/Xcode.app/Contents/Developer"
elif [[ -n "${clt_dir}" ]]; then
    DEVELOPER_SRC="${clt_dir}"
    DEVELOPER_DEST="/Library/Developer/CommandLineTools"
    DEVELOPER_SWITCH="/Library/Developer/CommandLineTools"
else
    echo "Error: archive contains neither an Xcode*.app nor CommandLineTools." >&2
    exit 1
fi

# The Darling prefix (default ~/.darling) is the virtual Darwin root and is
# plain host directories, so stage the tree into it from the host side —
# far faster than copying through emulated I/O. Boot once first so it exists.
timeout 900 darling shell /bin/bash -c 'true' </dev/null
PREFIX_DIR="${DPREFIX:-${HOME}/.darling}"
dest="${PREFIX_DIR}${DEVELOPER_DEST}"
echo "Staging $(basename "${DEVELOPER_SRC}") into ${dest}..."
mkdir -p "$(dirname "${dest}")"
rm -rf "${dest}"
mv "${DEVELOPER_SRC}" "${dest}"

run_step() {
    local name="$1"
    shift
    local log="${LOG_DIR}/xcodebuild-${name}.log"
    echo "=== ${name}: $* ==="
    if timeout 900 darling shell /bin/bash -c "$*" </dev/null >"${log}" 2>&1; then
        echo "ok ${name}"
        tail -n 5 "${log}"
    else
        echo "FAILED ${name} (see $(basename "${log}"))"
        tail -n 20 "${log}"
    fi
}

run_step "select" "sudo xcode-select --switch ${DEVELOPER_SWITCH}"
run_step "license" "sudo xcodebuild -license accept"
run_step "version" "xcodebuild -version"
run_step "showsdks" "xcodebuild -showsdks"
run_step "list-ctrlproxy" \
    "cd /Volumes/SystemRoot${PROJECT_ROOT} && xcodebuild -list -project ios/control-proxy/CtrlProxy.xcodeproj"

echo "xcodebuild probe finished; logs in scratch/darling/xcodebuild-*.log"
