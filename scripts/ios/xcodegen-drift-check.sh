#!/bin/bash
#
# Regenerates XcodeGen projects and fails if committed project files are stale.
# Use --ctrl-proxy for the TypeScript-triggered XCTestRunner integration job so
# unrelated iOS project generation cannot block that narrower path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/xcodegen_version.sh disable=SC1091
source "${SCRIPT_DIR}/xcodegen_version.sh"
# shellcheck source=scripts/ios/pbxproj_normalize.sh disable=SC1091
source "${SCRIPT_DIR}/pbxproj_normalize.sh"
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

# A changed project file is not automatically drift. XcodeGen 2.46.0 emits the
# PBXProject `targets = (...)` array in one of two environment-dependent orders
# for the same spec + pinned version (issue #4080), so a pure reorder must not
# fail the gate. Fold that one array's order out (normalize_pbxproj_targets) and
# compare against the committed bytes; anything that still differs is genuine
# staleness and is reported below.
REAL_DRIFT_PATHS=()
while IFS= read -r status_line; do
    [ -n "${status_line}" ] || continue
    # porcelain is "XY <path>"; a rename is "XY <old> -> <new>".
    path="${status_line:3}"
    path="${path##* -> }"

    if ! committed="$(git show "HEAD:${path}" 2>/dev/null)"; then
        # No committed version (new/untracked file) -- always real drift.
        REAL_DRIFT_PATHS+=("${path}")
        continue
    fi

    committed_norm="$(printf '%s' "${committed}" | normalize_pbxproj_targets)"
    generated_norm="$(normalize_pbxproj_targets < "${path}")"
    if [ "${committed_norm}" = "${generated_norm}" ]; then
        # Only the target-array order changed. Restore the committed bytes so the
        # working tree is clean for the build steps that run after this gate.
        git checkout -- "${path}"
    else
        REAL_DRIFT_PATHS+=("${path}")
    fi
done <<< "${STATUS_OUTPUT}"

if [ ${#REAL_DRIFT_PATHS[@]} -eq 0 ]; then
    echo "XcodeGen project files are in sync (PBXProject target-array order normalized, #4080)"
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
git status --short -- ${REAL_DRIFT_PATHS[@]+"${REAL_DRIFT_PATHS[@]}"} >&2
git diff -- ${REAL_DRIFT_PATHS[@]+"${REAL_DRIFT_PATHS[@]}"} >&2
exit 1
