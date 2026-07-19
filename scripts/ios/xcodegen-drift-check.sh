#!/bin/bash
#
# Regenerates XcodeGen projects and fails if committed project files are stale.
# Use --ctrl-proxy for the TypeScript-triggered XCTestRunner integration job so
# unrelated iOS project generation cannot block that narrower path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/xcodegen_version.sh
source "${SCRIPT_DIR}/xcodegen_version.sh"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IOS_DIR="${PROJECT_ROOT}/ios"
CTRL_PROXY_DIR="${PROJECT_ROOT}/ios/control-proxy"
CTRL_PROXY_PROJECT="ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"
SCOPE="${1:---all}"

usage() {
    echo "Usage: $0 [--all|--ctrl-proxy]" >&2
}

collect_all_project_files() {
    local path

    while IFS= read -r path; do
        DRIFT_PATHS+=("${path}")
    done < <(git ls-files "ios/**/project.pbxproj")

    while IFS= read -r path; do
        path="${path#"${PROJECT_ROOT}"/}"
        DRIFT_PATHS+=("${path}")
    done < <(find "${IOS_DIR}" -path "*/project.pbxproj" -type f 2>/dev/null | sort)
}

cd "${PROJECT_ROOT}"

DRIFT_PATHS=()
case "${SCOPE}" in
    --all)
        "${SCRIPT_DIR}/xcodegen-generate.sh"
        collect_all_project_files
        ;;
    --ctrl-proxy)
        # This path invokes xcodegen directly instead of going through
        # xcodegen-generate.sh, so it needs its own gate: generating with a
        # skewed version would produce the very ordering-only diff this check
        # then reports as staleness (issue #3975).
        require_pinned_xcodegen_version
        (cd "${CTRL_PROXY_DIR}" && xcodegen generate)
        DRIFT_PATHS=("${CTRL_PROXY_PROJECT}")
        ;;
    *)
        usage
        exit 2
        ;;
esac

if [ ${#DRIFT_PATHS[@]} -eq 0 ]; then
    echo "No XcodeGen project files found to check"
    exit 0
fi

STATUS_OUTPUT="$(git status --porcelain -- "${DRIFT_PATHS[@]}")"
if [ -z "${STATUS_OUTPUT}" ]; then
    echo "XcodeGen project files are in sync"
    exit 0
fi

echo "Error: XcodeGen project files are out of date after generation." >&2
# The pinned-version gate runs before generation, so a version skew can no
# longer explain reaching this line -- the project file is genuinely stale.
echo "Generated with XcodeGen ${XCODEGEN_VERSION} (pinned)." >&2
if [ "${SCOPE}" = "--ctrl-proxy" ]; then
    echo "Run 'cd ios/control-proxy && xcodegen generate' and commit the regenerated project file." >&2
else
    echo "Run scripts/ios/xcodegen-generate.sh and commit the regenerated project files." >&2
fi
git status --short -- "${DRIFT_PATHS[@]}" >&2
git diff -- "${DRIFT_PATHS[@]}" >&2
exit 1
