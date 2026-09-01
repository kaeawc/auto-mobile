#!/usr/bin/env bash
#
# Build Darling (https://darlinghq.org) from source on an Ubuntu GitHub runner
# and stage the install tree into a single tarball for caching (Darling CI
# experiment; see .github/workflows/darling-experiment.yml).
#
# Darling ships no prebuilt packages, and the community Docker images predate
# the 2022 userspace rewrite (darlingserver), so a from-source build is the
# only supported path. A COMPONENTS-restricted build (default cli_dev: CLI
# plus the frameworks Xcode command-line tools need) keeps the build inside
# the runner's 6-hour job limit; the resulting tarball (~1 GB installed) is
# cached keyed on (ref, components) so subsequent runs skip the build.
#
# Usage:
#   darling-build.sh --ref <git-tag-or-branch> --components <list> --output <file.tar.zst>

set -euo pipefail

REF=""
COMPONENTS=""
OUTPUT=""

usage() {
    echo "Usage: $0 --ref <git-tag> --components <comma-list> --output <file.tar.zst>" >&2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ref)
            REF="${2:-}"
            shift 2
            ;;
        --components)
            COMPONENTS="${2:-}"
            shift 2
            ;;
        --output)
            OUTPUT="${2:-}"
            shift 2
            ;;
        *)
            usage
            exit 2
            ;;
    esac
done

if [[ -z "${REF}" || -z "${COMPONENTS}" || -z "${OUTPUT}" ]]; then
    usage
    exit 2
fi

# Resolve the first candidate package apt actually knows about. Darling's
# documented dependency list targets several Ubuntu releases at once, and a
# few package names differ on noble (libtiff5-dev -> libtiff-dev, clang-15 ->
# distro default clang; Darling itself only requires clang >= 11).
pick_pkg() {
    local candidate
    for candidate in "$@"; do
        if apt-cache show "${candidate}" >/dev/null 2>&1; then
            echo "${candidate}"
            return 0
        fi
    done
    echo "Error: none of the candidate packages exist: $*" >&2
    return 1
}

free_runner_disk() {
    # The build tree needs ~16 GB on top of a ~5 GB source checkout; hosted
    # runners keep ~25 GB free on /. Drop the biggest preinstalled toolchains
    # we never use here. Best-effort: the paths differ across runner images.
    echo "Disk before cleanup:" && df -h /
    sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc \
        /usr/local/.ghcup /opt/hostedtoolcache/CodeQL 2>/dev/null || true
    if command -v docker >/dev/null 2>&1; then
        sudo docker image prune -af >/dev/null 2>&1 || true
    fi
    echo "Disk after cleanup:" && df -h /
}

if [[ -n "${CI:-}" ]]; then
    free_runner_disk
fi

echo "Installing Darling build dependencies..."
sudo apt-get update -qq

clang_pkg="$(pick_pkg clang-15 clang)"
tiff_pkg="$(pick_pkg libtiff5-dev libtiff-dev)"
stdcpp_pkg="$(pick_pkg libstdc++-12-dev libstdc++-13-dev libstdc++-14-dev)"

# Package set from https://docs.darlinghq.org/build-instructions.html for
# Ubuntu, with the per-release substitutions resolved above.
sudo apt-get install -y --no-install-recommends \
    cmake automake "${clang_pkg}" bison flex libfuse-dev libudev-dev \
    pkg-config libc6-dev-i386 gcc-multilib libcairo2-dev libgl1-mesa-dev \
    curl libglu1-mesa-dev "${tiff_pkg}" libfreetype6-dev git git-lfs \
    libelf-dev libxml2-dev libegl1-mesa-dev libfontconfig1-dev libbsd-dev \
    libxrandr-dev libxcursor-dev libgif-dev libavutil-dev libpulse-dev \
    libavformat-dev libavcodec-dev libswresample-dev libdbus-1-dev \
    libxkbfile-dev libssl-dev "${stdcpp_pkg}" ninja-build zstd

# Prefer the runner's spare data disk when present: /mnt has ~60 GB free on
# hosted runners, which comfortably holds the source + build trees.
WORK_ROOT="${RUNNER_TEMP:-/tmp}"
if [[ -d /mnt ]] && sudo mkdir -p /mnt/darling-work 2>/dev/null; then
    sudo chown "$(id -u):$(id -g)" /mnt/darling-work
    WORK_ROOT="/mnt/darling-work"
fi
echo "Building under ${WORK_ROOT}"

SRC_DIR="${WORK_ROOT}/darling-src"
STAGE_DIR="${WORK_ROOT}/darling-stage"

echo "Cloning darlinghq/darling at ${REF} (shallow, with submodules)..."
git clone --depth 1 --branch "${REF}" --recurse-submodules --shallow-submodules \
    https://github.com/darlinghq/darling.git "${SRC_DIR}"

echo "Configuring (COMPONENTS=${COMPONENTS})..."
cmake -S "${SRC_DIR}" -B "${SRC_DIR}/build" -GNinja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCOMPONENTS="${COMPONENTS}"

echo "Building with $(nproc) jobs..."
start_time=$(date +%s)
ninja -C "${SRC_DIR}/build"
echo "Build took $((($(date +%s) - start_time) / 60)) minutes."

echo "Staging install tree..."
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}"
DESTDIR="${STAGE_DIR}" cmake --install "${SRC_DIR}/build"

echo "Creating ${OUTPUT}..."
mkdir -p "$(dirname "${OUTPUT}")"
tar -C "${STAGE_DIR}" -I 'zstd -T0 -8' -cf "${OUTPUT}" .
du -h "${OUTPUT}"

# Reclaim the build tree immediately: the install + smoke steps still need
# working space on this runner.
rm -rf "${SRC_DIR}" "${STAGE_DIR}"
echo "Darling build staged to ${OUTPUT}."
