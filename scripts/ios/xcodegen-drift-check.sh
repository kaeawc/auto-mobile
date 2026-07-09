#!/bin/bash
#
# Regenerates XcodeGen projects and fails if committed project files are stale.
# Use --ctrl-proxy for the TypeScript-triggered XCTestRunner integration job so
# unrelated iOS project generation cannot block that narrower path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
if [ "${SCOPE}" = "--ctrl-proxy" ]; then
    echo "Run 'cd ios/control-proxy && xcodegen generate' and commit the regenerated project file." >&2
else
    echo "Run scripts/ios/xcodegen-generate.sh and commit the regenerated project files." >&2
fi
git status --short -- "${DRIFT_PATHS[@]}" >&2
git diff -- "${DRIFT_PATHS[@]}" >&2
exit 1
