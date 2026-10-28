#!/usr/bin/env bats
# scripts/media/generate-prototype-test-media.sh against a stub ffmpeg (#14257).

setup() {
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  export FFMPEG="$BATS_TEST_TMPDIR/bin/ffmpeg"
  export STUB_ENCODERS="libx264 aac libvpx-vp9 libopus"
  cat > "$FFMPEG" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "$*" = "-hide_banner -encoders" ]; then
  for encoder in $STUB_ENCODERS; do
    printf ' V....D %s             stub\n' "$encoder"
  done
  exit 0
fi
printf '%s\n' "$*" >> "$CALLS"
# The output file is the last argument; its content is a digest of the call, so
# identical calls write identical bytes. HLS also writes one segment.
out="${*: -1}"
printf '%s\n' "$*" > "$out"
prev=""
for arg in "$@"; do
  if [ "$prev" = -hls_segment_filename ]; then
    printf 'segment\n' > "${arg/\%03d/000}"
  fi
  prev="$arg"
done
STUB
  chmod +x "$FFMPEG"
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/media/generate-prototype-test-media.sh"
  OUT="$BATS_TEST_TMPDIR/out"
}

@test "writes every clip, the HLS ladder and a sorted manifest" {
  run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  [ "$output" = "$OUT" ]
  for file in colorBars-320x180.mp4 countdown-160x90.mp4 countdown-640x360.mp4 \
    countdown-320x180.webm hls/master.m3u8 hls/160x90.m3u8 hls/640x360.m3u8 \
    hls/160x90-000.ts hls/640x360-000.ts episode-1.m4a episode-5.m4a; do
    [ -f "$OUT/$file" ]
  done
  run awk '{print $2}' "$OUT/manifest.txt"
  [ "${lines[0]}" = colorBars-320x180.mp4 ]
  [ "${#lines[@]}" -eq 14 ]
  sorted="$(awk '{print $2}' "$OUT/manifest.txt" | LC_ALL=C sort)"
  [ "$output" = "$sorted" ]
  grep -q '^#EXT-X-STREAM-INF:.*RESOLUTION=160x90' "$OUT/hls/master.m3u8"
  grep -q '^#EXT-X-STREAM-INF:.*RESOLUTION=640x360' "$OUT/hls/master.m3u8"
}

@test "every encode is single-threaded, bitexact and drops metadata" {
  run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$CALLS")" -eq 11 ]
  while IFS= read -r call; do
    [[ "$call" == *"-map_metadata -1 -fflags +bitexact"* ]]
    [[ "$call" == *"-flags:a +bitexact"* ]]
    if [[ "$call" == *"-c:v "* ]]; then
      [[ "$call" == *"-threads 1"* ]]
    fi
  done < "$CALLS"
  grep -q 'smptebars=size=320x180:rate=30:duration=3' "$CALLS"
  grep -q -- '-c:v libvpx-vp9 .*-c:a libopus' "$CALLS"
  grep -q 'sine=frequency=660:sample_rate=44100:duration=5' "$CALLS"
}

@test "a second run writes the same manifest" {
  bash "$SCRIPT" "$OUT"
  cp "$OUT/manifest.txt" "$BATS_TEST_TMPDIR/first"
  bash "$SCRIPT" "$OUT"
  cmp "$BATS_TEST_TMPDIR/first" "$OUT/manifest.txt"
}

@test "defaults to scratch/prototype-media under the working directory" {
  cd "$BATS_TEST_TMPDIR"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$output" = scratch/prototype-media ]
  [ -f scratch/prototype-media/manifest.txt ]
}

@test "refuses with an install hint when ffmpeg is missing" {
  FFMPEG="$BATS_TEST_TMPDIR/bin/no-such-ffmpeg" run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"ffmpeg not found"* ]]
  [[ "$output" == *"apt-get install ffmpeg"* ]]
  [[ "$output" != *"-encoders"* ]]
  [ ! -e "$OUT" ]
}

@test "refuses naming each missing encoder before writing anything" {
  STUB_ENCODERS="libx264 aac" run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"lacks encoder(s): libvpx-vp9 libopus"* ]]
  [ ! -e "$OUT" ]
  [ ! -e "$CALLS" ]
}
