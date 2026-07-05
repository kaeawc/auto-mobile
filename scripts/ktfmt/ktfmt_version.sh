#!/usr/bin/env bash
#
# Single source of truth for the pinned ktfmt version *and* the helpers that
# enforce it.
#
# This file is *sourced* (not executed) by install_ktfmt.sh, validate_ktfmt.sh
# and apply_ktfmt.sh so the pin -- and the parse/gate logic around it -- lives in
# exactly one place. Bumping the pinned formatter version means editing the one
# KTFMT_VERSION line below; every consumer picks it up automatically, so they can
# never drift apart. See issue #2966: version/style-config drift silently
# reformats untouched files under the scoped PR check and only surfaces as red
# main post-merge (or worse, gets committed by the apply/write path), so the pin
# must be enforced, not merely declared.

KTFMT_VERSION="0.64"

# Parse the numeric version from `ktfmt --version` (e.g. "ktfmt version 0.64").
# Filter to ktfmt's own version line first so a JVM warning on stderr (the manual
# install runs `java -jar`) can't have *its* version grabbed instead. Prints the
# empty string if ktfmt is absent or emits nothing parseable.
installed_ktfmt_version() {
    local version_output
    version_output="$(ktfmt --version 2>&1)" || true
    awk 'tolower($0) ~ /ktfmt version/ {
        if (match($0, /[0-9]+\.[0-9]+(\.[0-9]+)?/)) {
            print substr($0, RSTART, RLENGTH)
            exit
        }
    }' <<<"$version_output"
}

# Fingerprint gate (issue #2966): assert the ktfmt on PATH is EXACTLY the pinned
# version, else print an actionable message and `exit 1`. Both the validate
# (read) and apply (write) paths call this before touching any file, so a
# formatter whose version differs from the pin fails loudly instead of silently
# reformatting -- on the PR, post-merge, or on a developer's `apply` run. A
# matching version also implies `--google-style` support, so this subsumes the
# older flag probe. Colours are referenced via ${RED:-} so this is safe to call
# even before the caller defines them.
require_pinned_ktfmt_version() {
    local found
    found="$(installed_ktfmt_version)"
    if [[ "$found" == "$KTFMT_VERSION" ]]; then
        return 0
    fi

    echo -e "${RED:-}ktfmt version mismatch: found '${found:-unknown}', this repo pins '${KTFMT_VERSION}'.${NC:-}"
    echo -e "${RED:-}A different formatter version reformats files differently than the pin (issue #2966), so this fails loudly instead of proceeding.${NC:-}"
    echo -e "${RED:-}Install the pinned version: re-run scripts/ktfmt/install_ktfmt.sh, or install ktfmt ${KTFMT_VERSION} manually.${NC:-}"
    exit 1
}
