#!/usr/bin/env bash
# Generate Swift-DocC reference documentation for the AutoMobileSDK.
# Output is a static-hostable site compatible with GitHub Pages.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK_DIR="${REPO_ROOT}/ios/auto-mobile-sdk"
OUTPUT_DIR="${REPO_ROOT}/docs/ios-sdk"
DOCC_OUTPUTS="${SDK_DIR}/.build/plugins/Swift-DocC/outputs"

echo "==> Building AutoMobileSDK documentation..."

cd "${SDK_DIR}"

if swift package plugin generate-documentation --help >/dev/null 2>&1; then
    # The plugin builds docs into an intermediate sandbox directory and then
    # tries to move the result to --output-path. On sandboxed environments the
    # move may fail (EPERM) even though the build itself succeeds. We tolerate
    # that error and copy from the intermediate location instead.
    if ! swift package generate-documentation \
        --target AutoMobileSDK \
        --transform-for-static-hosting \
        --hosting-base-path auto-mobile/ios-sdk; then
        # The plugin may fail with EPERM when moving the archive out of
        # the sandbox. If the archive was still produced we continue;
        # otherwise we surface the real failure.
        if ! find "${DOCC_OUTPUTS}" -name "AutoMobileSDK.doccarchive" -type d 2>/dev/null | grep -q .; then
            echo "ERROR: DocC generation failed and no archive was produced." >&2
            exit 1
        fi
        echo "WARNING: generate-documentation exited non-zero but archive exists; continuing."
    fi

    # Find the .doccarchive wherever the plugin placed it
    ARCHIVE=$(find "${DOCC_OUTPUTS}" -name "AutoMobileSDK.doccarchive" -type d 2>/dev/null | head -1)
    if [ -z "${ARCHIVE}" ]; then
        echo "ERROR: DocC archive not found under ${DOCC_OUTPUTS}" >&2
        exit 1
    fi

    mkdir -p "$(dirname "${OUTPUT_DIR}")"
    rm -rf "${OUTPUT_DIR}"
    cp -R "${ARCHIVE}" "${OUTPUT_DIR}"
else
    echo "swift-docc-plugin not available, falling back to xcodebuild docbuild..."

    DERIVED_DATA=$(mktemp -d)
    trap 'rm -rf "${DERIVED_DATA}"' EXIT

    xcodebuild docbuild \
        -scheme AutoMobileSDK \
        -destination generic/platform=iOS \
        -derivedDataPath "${DERIVED_DATA}" \
        OTHER_DOCC_FLAGS="--transform-for-static-hosting --hosting-base-path auto-mobile/ios-sdk"

    ARCHIVE=$(find "${DERIVED_DATA}" -name "AutoMobileSDK.doccarchive" -type d | head -1)
    if [ -z "${ARCHIVE}" ]; then
        echo "ERROR: Could not find .doccarchive in derived data" >&2
        exit 1
    fi

    mkdir -p "$(dirname "${OUTPUT_DIR}")"
    rm -rf "${OUTPUT_DIR}"
    cp -R "${ARCHIVE}" "${OUTPUT_DIR}"
fi

echo "==> Documentation generated at ${OUTPUT_DIR}"
