#!/usr/bin/env bash
#
# Single source of truth for the pinned ktfmt version.
#
# This file is *sourced* (not executed) by both install_ktfmt.sh and
# validate_ktfmt.sh so the pin lives in exactly one place. Bumping the pinned
# formatter version means editing this one line -- both the installer and the
# validator's fingerprint gate pick it up automatically, so they can never drift
# apart. See issue #2966: version/style-config drift silently reformats untouched
# files under the scoped PR check and only surfaces as red main post-merge, so
# the pin must be enforced, not merely declared.
#
# shellcheck disable=SC2034  # consumed by the scripts that source this file.
KTFMT_VERSION="0.64"
