#!/usr/bin/env bash
#
# Generate the deterministic prototype test media (#14257) with ffmpeg's lavfi
# sources, so no clip has to be committed (video files are LFS-tracked).
#
# Output (default scratch/prototype-media/):
#   colorBars-320x180.mp4    H.264/AAC, 3 s, SMPTE bars and a 440 Hz tone
#   countdown-160x90.mp4     H.264/AAC, 3 s, testsrc2 (frame counter) and a tone
#   countdown-640x360.mp4    H.264/AAC, 10 s
#   countdown-320x180.webm   VP9/Opus, 5 s
#   hls/master.m3u8          HLS ladder: 160x90 and 640x360 renditions, 6 s
#   episode-1.m4a .. episode-5.m4a   AAC audio, 5 s each, one tone per episode
#   manifest.txt             one "<sha256>  <file>" line per generated file
#
# The same ffmpeg build produces byte-identical files on every run: encoders run
# single-threaded with bitexact flags and no metadata.
#
# Usage:
#   scripts/media/generate-prototype-test-media.sh [out-dir]
#
# Environment:
#   FFMPEG  ffmpeg binary to use (default: ffmpeg on PATH)

set -euo pipefail

OUT="${1:-scratch/prototype-media}"
FFMPEG="${FFMPEG:-ffmpeg}"
REQUIRED_ENCODERS=(libx264 aac libvpx-vp9 libopus)

install_hint() {
  echo "Install ffmpeg with libx264, libvpx and libopus: 'brew install ffmpeg' (macOS) or 'sudo apt-get install ffmpeg' (Debian/Ubuntu)." >&2
}

if ! command -v "${FFMPEG}" >/dev/null 2>&1; then
  echo "generate-prototype-test-media.sh: ffmpeg not found (set FFMPEG or put ffmpeg on PATH)." >&2
  install_hint
  exit 1
fi

encoders="$("${FFMPEG}" -hide_banner -encoders 2>/dev/null)" || {
  echo "generate-prototype-test-media.sh: '${FFMPEG} -encoders' failed." >&2
  exit 1
}
missing=()
for encoder in "${REQUIRED_ENCODERS[@]}"; do
  if ! grep -Eq "^ [A-Z.]{6} ${encoder} " <<<"${encoders}"; then
    missing+=("${encoder}")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "generate-prototype-test-media.sh: ffmpeg lacks encoder(s): ${missing[*]}." >&2
  install_hint
  exit 1
fi

mkdir -p "${OUT}/hls"

# Shared flags: overwrite and quiet (before the inputs); no metadata and a bitexact
# container (after them).
GLOBAL=(-hide_banner -loglevel error -y)
OUTPUT=(-map_metadata -1 -fflags +bitexact)
H264=(-c:v libx264 -preset veryfast -profile:v baseline -pix_fmt yuv420p -threads 1
  -flags:v +bitexact -x264-params "keyint=30:min-keyint=30:scenecut=0")
AAC=(-c:a aac -b:a 64k -ac 1 -ar 44100 -flags:a +bitexact)

# video <out> <lavfi video source> <size> <seconds> <tone Hz> <codec args...>
video() {
  local out="$1" source="$2" size="$3" seconds="$4" tone="$5"
  shift 5
  "${FFMPEG}" "${GLOBAL[@]}" \
    -f lavfi -i "${source}=size=${size}:rate=30:duration=${seconds}" \
    -f lavfi -i "sine=frequency=${tone}:sample_rate=44100:duration=${seconds}" \
    "${OUTPUT[@]}" "$@" -shortest "${OUT}/${out}"
}

video colorBars-320x180.mp4 smptebars 320x180 3 440 "${H264[@]}" "${AAC[@]}" -movflags +faststart
video countdown-160x90.mp4 testsrc2 160x90 3 440 "${H264[@]}" "${AAC[@]}" -movflags +faststart
video countdown-640x360.mp4 testsrc2 640x360 10 440 "${H264[@]}" "${AAC[@]}" -movflags +faststart
video countdown-320x180.webm testsrc2 320x180 5 440 \
  -c:v libvpx-vp9 -deadline good -cpu-used 4 -row-mt 0 -threads 1 -b:v 200k -pix_fmt yuv420p \
  -c:a libopus -b:a 48k -ac 1 -ar 48000 -flags:a +bitexact

for rendition in 160x90 640x360; do
  video "hls/${rendition}.m3u8" testsrc2 "${rendition}" 6 440 "${H264[@]}" "${AAC[@]}" \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_flags independent_segments \
    -hls_segment_filename "${OUT}/hls/${rendition}-%03d.ts"
done
cat >"${OUT}/hls/master.m3u8" <<'EOF'
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,CODECS="avc1.42c00c,mp4a.40.2"
160x90.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
640x360.m3u8
EOF

tones=(220 330 440 550 660)
for index in 1 2 3 4 5; do
  "${FFMPEG}" "${GLOBAL[@]}" \
    -f lavfi -i "sine=frequency=${tones[index - 1]}:sample_rate=44100:duration=5" \
    "${OUTPUT[@]}" "${AAC[@]}" -vn "${OUT}/episode-${index}.m4a"
done

# macOS ships shasum, Linux sha256sum; both print "<hash>  <file>".
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

# Sorted, relative paths so the manifest is stable across runs and machines.
(
  cd "${OUT}"
  find . -type f ! -name manifest.txt | LC_ALL=C sort | sed 's|^\./||' | while IFS= read -r file; do
    sha256 "${file}"
  done
) >"${OUT}/manifest.txt"

echo "${OUT}"
