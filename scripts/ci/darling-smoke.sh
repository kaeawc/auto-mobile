#!/usr/bin/env bash
#
# Probe battery for the Darling CI experiment: how much of AutoMobile's
# macOS-only tooling can run on a Linux runner under Darling
# (https://docs.darlinghq.org/what-to-try.html)?
#
# Strategy: keep every orchestration script on the Linux host and route only
# the actual Mach-O binaries (XcodeGen, SwiftLint) through `darling shell`
# via PATH shims. The shims translate the working directory through
# /Volumes/SystemRoot, Darling's mount of the host filesystem, so repo
# scripts like xcodegen-drift-check.sh run unmodified.
#
# Each probe records pass / FAIL / blocked-upstream (dyld: a framework this
# Darling release does not implement yet, e.g. CryptoKit, Combine) / info /
# n-a into a summary table (written to $GITHUB_STEP_SUMMARY when set).
# Exit codes: 2 = darling not installed, 1 = the boot probe or a genuine
# probe FAILed, 0 = nothing failed beyond upstream-blocked findings.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if ! command -v darling >/dev/null 2>&1; then
    echo "Error: 'darling' is not on PATH. Run scripts/ci/darling-install.sh first." >&2
    exit 2
fi

LOG_DIR="${PROJECT_ROOT}/scratch/darling"
TOOLS_DIR="${DARLING_TOOLS_DIR:-${RUNNER_TEMP:-/tmp}/darling-tools}"
SHIM_DIR="${TOOLS_DIR}/shims"
MACOS_BIN_DIR="${TOOLS_DIR}/macos/bin"
mkdir -p "${LOG_DIR}" "${SHIM_DIR}" "${MACOS_BIN_DIR}" "${TOOLS_DIR}/macos/share"

# Generous ceilings: the first `darling shell` initializes the prefix and
# starts darlingserver, and emulated SwiftSyntax binaries are not fast.
BOOT_TIMEOUT="${DARLING_BOOT_TIMEOUT:-900}"
export DARLING_CMD_TIMEOUT="${DARLING_CMD_TIMEOUT:-900}"

PROBE_NAMES=()
PROBE_RESULTS=()
PROBE_NOTES=()

record() {
    PROBE_NAMES+=("$1")
    PROBE_RESULTS+=("$2")
    PROBE_NOTES+=("$3")
    printf '[%s] %s — %s\n' "$2" "$1" "$3"
}

# Run one host-side command as a probe, capturing output to a per-probe log.
# A dyld "Library not loaded" failure is classified as blocked-upstream with
# the missing framework named (Darling grows frameworks release by release —
# e.g. AVFAudio/LAContext landed in Feb 2026 — so these flip on their own),
# and is not counted as a FAIL by fail_count.
probe() {
    local name="$1"
    shift
    local log="${LOG_DIR}/probe-${name//[^A-Za-z0-9._-]/_}.log"
    if "$@" >"${log}" 2>&1; then
        record "${name}" "pass" "$(tail -n 1 "${log}" | cut -c1-120)"
    elif grep -q 'Library not loaded:' "${log}"; then
        local missing
        missing="$(grep -m 1 'Library not loaded:' "${log}" | sed 's/.*Library not loaded: //' | cut -c1-100)"
        record "${name}" "blocked-upstream" "dyld: missing ${missing}"
    else
        record "${name}" "FAIL" "see $(basename "${log}")"
    fi
}

# Informational probe: records the outcome either way, never FAILs the run.
probe_info() {
    local name="$1"
    shift
    local log="${LOG_DIR}/probe-${name//[^A-Za-z0-9._-]/_}.log"
    if "$@" >"${log}" 2>&1; then
        record "${name}" "pass" "$(tail -n 1 "${log}" | cut -c1-120)"
    else
        record "${name}" "info" "$(tail -n 1 "${log}" | cut -c1-120)"
    fi
}

# Run a command line inside Darling's Darwin environment. `darling shell`
# treats its arguments as literal argv words (no shell evaluation), so hand
# the line to the guest's bash explicitly; </dev/null guards against stdin
# hangs. Darling maps the Linux cwd to the same path inside the prefix, so
# relative paths work. (Both facts proven in kaeawc/spectra#452.)
dsh() {
    timeout "${DARLING_CMD_TIMEOUT}" darling shell /bin/bash -c "$1" </dev/null
}

check_uname_darwin() {
    local out
    out="$(timeout "${DARLING_CMD_TIMEOUT}" darling shell /bin/bash -c 'uname -s' </dev/null)"
    echo "${out}"
    [[ "${out}" == *Darwin* ]]
}

# Write a host-side shim that forwards a Mach-O CLI (staged in
# ${MACOS_BIN_DIR}) into darling, preserving argv and the working directory.
make_shim() {
    local name="$1"
    cat >"${SHIM_DIR}/${name}" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name="$(basename "${BASH_SOURCE[0]}")"
real="$(cd "${here}/../macos/bin" && pwd)/${name}"
if [[ ! -x "${real}" ]]; then
    echo "${name} shim: ${real} is not installed" >&2
    exit 127
fi
args=""
for a in "$@"; do
    args+=" $(printf '%q' "$a")"
done
# darling shell maps the host cwd into the prefix, so only the absolute
# path to the Mach-O binary needs the /Volumes/SystemRoot host-FS prefix.
exec timeout "${DARLING_CMD_TIMEOUT:-900}" darling shell /bin/bash -c \
    "exec $(printf '%q' "/Volumes/SystemRoot${real}")${args}" </dev/null
SHIM
    chmod +x "${SHIM_DIR}/${name}"
}

summarize() {
    local out="${LOG_DIR}/summary.md"
    {
        echo "## Darling experiment probe results"
        echo ""
        echo "| Probe | Result | Note |"
        echo "| --- | --- | --- |"
        local i
        for i in "${!PROBE_NAMES[@]}"; do
            printf '| %s | %s | %s |\n' \
                "${PROBE_NAMES[$i]}" "${PROBE_RESULTS[$i]}" "${PROBE_NOTES[$i]//|/\\|}"
        done
        echo ""
        echo "Logs: scratch/darling/ (uploaded as the darling-experiment-logs artifact)."
    } >"${out}"
    cat "${out}"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        cat "${out}" >>"${GITHUB_STEP_SUMMARY}"
    fi
}

fail_count() {
    local count=0 result
    for result in ${PROBE_RESULTS[@]+"${PROBE_RESULTS[@]}"}; do
        if [[ "${result}" == "FAIL" ]]; then
            count=$((count + 1))
        fi
    done
    echo "${count}"
}

# ---- Tier 0: does Darwin boot at all? -------------------------------------

boot_log="${LOG_DIR}/probe-boot.log"
if timeout "${BOOT_TIMEOUT}" darling shell /bin/bash -c 'echo darling-boot-ok' \
    </dev/null >"${boot_log}" 2>&1 \
    && grep -q darling-boot-ok "${boot_log}"; then
    record "darling shell boot" "pass" "prefix initialized, darlingserver running"
else
    record "darling shell boot" "FAIL" "darling shell failed; see probe-boot.log"
    summarize
    exit 1
fi

probe "uname reports Darwin" check_uname_darwin
probe "sw_vers" dsh 'sw_vers'

# Host filesystem round-trip: repo scripts on the host must see files that
# Mach-O tools write through /Volumes/SystemRoot.
hostfs_marker="${LOG_DIR}/hostfs-marker.txt"
rm -f "${hostfs_marker}"
probe "host FS write via /Volumes/SystemRoot" bash -c \
    "timeout \"\${DARLING_CMD_TIMEOUT}\" darling shell /bin/bash -c 'echo from-darling > /Volumes/SystemRoot${hostfs_marker}' </dev/null && grep -q from-darling '${hostfs_marker}'"

# ---- Tier 1: what toolchain does this COMPONENTS build ship? ---------------

for tool in clang swiftc xcrun xcodebuild otool nm plutil codesign file sqlite3; do
    tool_log="${LOG_DIR}/probe-which-${tool}.log"
    if timeout "${DARLING_CMD_TIMEOUT}" darling shell /bin/bash -c "command -v ${tool}" </dev/null >"${tool_log}" 2>&1; then
        record "darling ships ${tool}" "pass" "$(tail -n 1 "${tool_log}")"
    else
        # Absence is a finding, not a failure: Darling only bundles Apple's
        # open-source tools; xcodebuild ships with Xcode, which is
        # EULA-restricted (see darling-xcodebuild-probe.sh).
        record "darling ships ${tool}" "n/a" "not present in this COMPONENTS build"
    fi
done

# /usr/bin/clang and /usr/bin/swiftc in the guest are shims that forward to
# /Library/Developer/DarlingCLT — which Darling populates by downloading
# APPLE'S Command Line Tools (clt_install.py fetches them from
# swdistcache.darlinghq.org after an interactive agreement to Apple's Xcode
# license). Same EULA gate as darling-xcodebuild-probe.sh, so CI never
# installs it; only compile when the real CLT is already present.
if timeout "${DARLING_CMD_TIMEOUT}" darling shell /bin/bash -c \
    'test -x /Library/Developer/DarlingCLT/usr/bin/clang' </dev/null >/dev/null 2>&1; then
    printf 'int main(void){__builtin_printf("hello-from-darling-clang\\n");return 0;}\n' >"${LOG_DIR}/hello.c"
    probe "clang compiles and runs C" dsh \
        "cd /Volumes/SystemRoot${LOG_DIR} && clang hello.c -o hello-c && ./hello-c"
    printf 'print("hello-from-darling-swift")\n' >"${LOG_DIR}/hello.swift"
    probe "swiftc compiles and runs Swift" dsh \
        "cd /Volumes/SystemRoot${LOG_DIR} && swiftc hello.swift -o hello-swift && ./hello-swift"
else
    record "clang/swiftc compile" "n/a" \
        "DarlingCLT absent: guest compilers are Apple's CLT behind Apple's Xcode EULA; CI never installs it"
fi

# What the guest's xcodebuild/xcrun shims say without Apple's CLT installed —
# informational: expected to point at the (EULA-gated) CLT installer.
probe_info "xcodebuild -version (no Apple CLT)" dsh 'xcodebuild -version'
probe_info "xcrun --show-sdk-path (no Apple CLT)" dsh 'xcrun --show-sdk-path'

# ---- Tier 2: AutoMobile's real macOS CI tools, as Mach-O under Darling -----

# XcodeGen: same pinned release archive the macOS jobs install
# (scripts/ios/xcodegen_version.sh), staged host-side and executed in darling
# through the shim. Success here means the ios-xcodegen drift gate could in
# principle leave macOS runners.
# shellcheck source=scripts/ios/xcodegen_version.sh disable=SC1091
source "${PROJECT_ROOT}/scripts/ios/xcodegen_version.sh"
xcodegen_zip="${TOOLS_DIR}/xcodegen.zip"
if curl -fsSL -o "${xcodegen_zip}" "${XCODEGEN_RELEASE_URL}" \
    && echo "${XCODEGEN_RELEASE_SHA256}  ${xcodegen_zip}" | sha256sum -c - >/dev/null 2>&1; then
    unzip -qq -o "${xcodegen_zip}" -d "${TOOLS_DIR}/xcodegen-extract"
    cp "${TOOLS_DIR}/xcodegen-extract/xcodegen/bin/xcodegen" "${MACOS_BIN_DIR}/xcodegen"
    chmod +x "${MACOS_BIN_DIR}/xcodegen"
    rm -rf "${TOOLS_DIR}/macos/share/xcodegen"
    cp -R "${TOOLS_DIR}/xcodegen-extract/xcodegen/share/xcodegen" "${TOOLS_DIR}/macos/share/xcodegen"
    make_shim xcodegen
    export PATH="${SHIM_DIR}:${PATH}"

    probe "xcodegen --version (pinned ${XCODEGEN_VERSION})" bash -c \
        "v=\"\$(xcodegen --version)\"; echo \"\${v}\"; [[ \"\${v}\" == *\"${XCODEGEN_VERSION}\"* ]]"
    # The drift check cannot pass while xcodegen itself cannot load, and its
    # version-parse discards the dyld stderr that probe() classifies on — so
    # gate it on the version probe instead of re-failing for the same cause.
    if [[ "${PROBE_RESULTS[$((${#PROBE_RESULTS[@]} - 1))]}" == "pass" ]]; then
        probe "xcodegen-drift-check.sh --ctrl-proxy" \
            bash "${PROJECT_ROOT}/scripts/ios/xcodegen-drift-check.sh" --ctrl-proxy
    else
        record "xcodegen-drift-check.sh --ctrl-proxy" "blocked-upstream" \
            "skipped: xcodegen does not load under this Darling release (previous row)"
    fi
else
    record "xcodegen download" "FAIL" "could not fetch/verify pinned XcodeGen archive"
fi

# SwiftLint: the pinned portable macOS binary (a large SwiftSyntax CLI — a
# good stress test for Darling). Passing would let the swiftlint job leave
# macos-14. Note: upstream publishes no digest for this asset and the repo's
# own installer does not pin one either, so this download is version-pinned only.
# shellcheck source=scripts/swiftlint/swiftlint_version.sh disable=SC1091
source "${PROJECT_ROOT}/scripts/swiftlint/swiftlint_version.sh"
swiftlint_zip="${TOOLS_DIR}/swiftlint.zip"
if curl -fsSL -o "${swiftlint_zip}" \
    "https://github.com/realm/SwiftLint/releases/download/${SWIFTLINT_VERSION}/portable_swiftlint.zip"; then
    unzip -qq -o "${swiftlint_zip}" -d "${TOOLS_DIR}/swiftlint-extract"
    cp "${TOOLS_DIR}/swiftlint-extract/swiftlint" "${MACOS_BIN_DIR}/swiftlint"
    chmod +x "${MACOS_BIN_DIR}/swiftlint"
    make_shim swiftlint
    export PATH="${SHIM_DIR}:${PATH}"

    probe "swiftlint version (pinned ${SWIFTLINT_VERSION})" bash -c \
        "v=\"\$(swiftlint version)\"; echo \"\${v}\"; [[ \"\${v}\" == *\"${SWIFTLINT_VERSION}\"* ]]"
    probe "swiftlint lints ios/XCTestRunner" bash -c \
        "cd '${PROJECT_ROOT}' && swiftlint lint --quiet ios/XCTestRunner/Sources"
else
    record "swiftlint download" "FAIL" "could not fetch pinned SwiftLint archive"
fi

# Mach-O inspection of a real artifact, if this build bundles otool.
if timeout "${DARLING_CMD_TIMEOUT}" darling shell /bin/bash -c 'command -v otool' </dev/null >/dev/null 2>&1 \
    && [[ -x "${MACOS_BIN_DIR}/xcodegen" ]]; then
    probe "otool -L on xcodegen" dsh \
        "otool -L /Volumes/SystemRoot${MACOS_BIN_DIR}/xcodegen"
fi

# ---- Report -----------------------------------------------------------------

summarize
failed="$(fail_count)"
if [[ "${failed}" -gt 0 ]]; then
    echo "${failed} probe(s) failed."
    exit 1
fi
echo "All attempted probes passed."
