#!/usr/bin/env bash
# Package the ad-hoc-signed universal iOS simulator viewer template for release.
# ditto preserves the executable mode and signature, with one top-level .app.
# Usage: scripts/ios/build-prototype-viewer-release.sh <output-zip>
set -euo pipefail

output_path="${1:?Usage: build-prototype-viewer-release.sh <output-zip>}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v ditto >/dev/null || { echo "ERROR: ditto is required" >&2; exit 1; }
output_dir="$(dirname "${output_path}")"
mkdir -p "${output_dir}"
output_path="$(cd "${output_dir}" && pwd -P)/$(basename "${output_path}")"
work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

bash "${repo_root}/scripts/ios/prototype-viewer-build.sh" "${work_dir}" >/dev/null
# Write a fresh archive so a previous output cannot retain extra entries.
ditto -c -k --norsrc --noextattr --keepParent "${work_dir}/PrototypeViewer.app" "${work_dir}/viewer.zip"
mv -f "${work_dir}/viewer.zip" "${output_path}"
echo "${output_path}"
