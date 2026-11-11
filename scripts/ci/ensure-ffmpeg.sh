#!/usr/bin/env bash
# Make ffmpeg available without apt (#17964).
#
# An ffmpeg already on PATH is used as is. Otherwise this downloads a pinned
# static build from a GitHub release, checks its sha256, and installs it under
# the cache dir (cached by actions/cache like MediaMTX). The directory holding
# the binary is appended to $GITHUB_PATH when that is set, so later steps find
# it. apt is never used: Ubuntu mirrors failing to resolve kept this job red.

set -euo pipefail

readonly FFMPEG_STATIC_TAG="b6.0"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cache_dir="${AUTOMOBILE_FFMPEG_CACHE_DIR:-${repo_root}/scratch/ffmpeg}"
base_url="${AUTOMOBILE_FFMPEG_BASE_URL:-https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_TAG}}"

fail() {
  printf 'ensure-ffmpeg: %s\n' "$*" >&2
  exit 1
}

if command -v ffmpeg >/dev/null 2>&1; then
  printf 'ensure-ffmpeg: using %s\n' "$(command -v ffmpeg)"
  exit 0
fi

case "$(uname -s):$(uname -m)" in
  Linux:x86_64 | Linux:amd64)
    asset="ffmpeg-linux-x64.gz"
    want_sha="17c1ae10b52ac499180679fe6ba77e17642390c4eedb0f1e3b0ac045da55128f"
    ;;
  Linux:aarch64 | Linux:arm64)
    asset="ffmpeg-linux-arm64.gz"
    want_sha="2b708b2d15041d2a192c1db24c7a8a1d24f645a8242dce1c744ff2392b86ada1"
    ;;
  *)
    fail "no pinned static ffmpeg for $(uname -s)/$(uname -m); install ffmpeg first"
    ;;
esac

install_dir="${cache_dir}/${FFMPEG_STATIC_TAG}"
binary="${install_dir}/ffmpeg"
if [[ ! -x "${binary}" ]]; then
  mkdir -p "${install_dir}"
  archive="$(mktemp "${install_dir}/.${asset}.XXXXXX")"
  trap 'rm -f "${archive}"' EXIT
  curl --fail --location --retry 3 --connect-timeout 30 --max-time 300 \
    --output "${archive}" "${base_url}/${asset}"
  got_sha="$(sha256sum "${archive}" | awk '{print $1}')"
  [[ "${got_sha}" == "${want_sha}" ]] || fail "checksum mismatch for ${asset} (wanted ${want_sha}, got ${got_sha})"
  gunzip -c "${archive}" >"${binary}.tmp"
  chmod +x "${binary}.tmp"
  mv "${binary}.tmp" "${binary}"
fi

printf 'ensure-ffmpeg: using pinned static build %s\n' "${binary}"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "${install_dir}" >>"${GITHUB_PATH}"
fi
