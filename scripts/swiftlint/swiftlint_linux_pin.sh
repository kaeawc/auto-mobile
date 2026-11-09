#!/usr/bin/env bash
# shellcheck disable=SC2034 # Read by the scripts that source this pin.

# Pin for the Linux SwiftLint binary used by the SwiftLint CI job (#17581).
# The version must equal SWIFTLINT_VERSION in swiftlint_version.sh (the Mac
# lane's pin); scripts/swiftlint/check_swiftlint_pin_consistency.sh fails when
# they diverge. When bumping SwiftLint, update both files and replace the
# SHA-256 with the digest of the new release's swiftlint_linux.zip.

SWIFTLINT_LINUX_VERSION="0.57.0"
SWIFTLINT_LINUX_ASSET="swiftlint_linux.zip"
SWIFTLINT_LINUX_SHA256="def1803e705c738c97fbc275c34e7a2e0278944776a8b9c56ebe8c444ea57407"
