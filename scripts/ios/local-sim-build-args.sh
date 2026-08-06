#!/bin/bash
#
# Extra xcodebuild build settings for LOCAL iOS Simulator builds (issue #5024).
#
# `generic/platform=iOS Simulator` with no arch pin builds a fat x86_64+arm64
# binary. On an Apple Silicon host the simulator runs arm64, so the x86_64 slice
# is compiled, linked, and thrown away — every file built twice. These headless
# script builds also never feed Xcode's index, so the default index-store pass
# is wasted work.
#
# `local_sim_build_args` emits (one per line) the settings that trim a build to
# the arch the local simulator actually runs and skip the index store — but ONLY
# on a local arm64 host. It emits nothing under CI (where universal artifacts may
# be wanted) or on a non-arm64 host (Intel simulators need x86_64), so those
# paths keep building universal. The release IPA path
# (ctrl-proxy-create-ipa.sh) deliberately does not consult this helper.
#
# Side-effect free and safe to source. Callers collect the lines into an array,
# e.g.:
#   EXTRA_ARGS=()
#   while IFS= read -r a; do [ -n "$a" ] && EXTRA_ARGS+=("$a"); done \
#     < <(local_sim_build_args)
#   xcodebuild ... "${EXTRA_ARGS[@]}"

# shellcheck source=scripts/lib/shell-core.sh disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/shell-core.sh"

local_sim_build_args() {
    # CI may want universal simulator artifacts; leave the build untouched.
    [ -n "${CI:-}" ] && return 0
    # Intel hosts run x86_64 simulators; only arm64 hosts can drop a slice.
    [ "$(detect_arch)" = "arm64" ] || return 0
    printf '%s\n' \
        "ONLY_ACTIVE_ARCH=YES" \
        "ARCHS=arm64" \
        "COMPILER_INDEX_STORE_ENABLE=NO"
}
