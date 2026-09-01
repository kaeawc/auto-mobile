#!/usr/bin/env bash
#
# Install Darling from the prebuilt debs attached to a darlinghq/darling
# GitHub release (working setup proven in kaeawc/spectra#452). The debs
# target Ubuntu 24.04 (noble) amd64 — run this only on a matching machine.
# Uses sudo for apt; do not run the whole script as root.
#
# Only the minimal CLI dependency closure is installed: the full `darling`
# metapackage drags in GUI, Python 2, Ruby, and Perl components the smoke
# probes never touch.
#
# Usage: darling-install.sh <debs-zip-url> <sha256>

set -euo pipefail

DEBS_URL="${1:-}"
DEBS_SHA256="${2:-}"
if [[ -z "${DEBS_URL}" || -z "${DEBS_SHA256}" ]]; then
    echo "Usage: $0 <debs-zip-url> <sha256>" >&2
    exit 2
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "Downloading Darling debs..."
curl -fsSL --retry 3 -o "${WORK_DIR}/darling-debs.zip" "${DEBS_URL}"
# Release assets are mutable; verify the bytes rather than trusting the tag.
echo "${DEBS_SHA256}  ${WORK_DIR}/darling-debs.zip" | sha256sum -c -
unzip -q "${WORK_DIR}/darling-debs.zip" -d "${WORK_DIR}/debs"

sudo apt-get update -qq
sudo apt-get install -y \
    "${WORK_DIR}"/debs/debs_*/darling-core_*.deb \
    "${WORK_DIR}"/debs/debs_*/darling-system_*.deb \
    "${WORK_DIR}"/debs/debs_*/darling-cli-gui-common_*.deb \
    "${WORK_DIR}"/debs/debs_*/darling-cli-python2-common_*.deb \
    "${WORK_DIR}"/debs/debs_*/darling-cli_*.deb

echo "Darling installed: $(command -v darling)"
