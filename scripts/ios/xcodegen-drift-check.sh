#!/bin/bash
#
# Regenerates XcodeGen projects and fails if the committed CtrlProxy project file
# is stale. This catches missing pbxproj updates before Xcode reports confusing
# compile errors from an out-of-date target file list.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CTRL_PROXY_PROJECT="ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"

cd "${PROJECT_ROOT}"

"${SCRIPT_DIR}/xcodegen-generate.sh"

if [ -z "$(git status --porcelain -- "${CTRL_PROXY_PROJECT}")" ]; then
    echo "CtrlProxy.xcodeproj/project.pbxproj is in sync with ios/control-proxy/project.yml"
    exit 0
fi

echo "Error: CtrlProxy.xcodeproj/project.pbxproj is out of date after xcodegen generation." >&2
echo "Run scripts/ios/xcodegen-generate.sh and commit the regenerated project file." >&2
git status --short -- "${CTRL_PROXY_PROJECT}" >&2
git diff -- "${CTRL_PROXY_PROJECT}" >&2
exit 1
