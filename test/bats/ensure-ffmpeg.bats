#!/usr/bin/env bats
#
# scripts/ci/ensure-ffmpeg.sh: use the runner's ffmpeg when present, otherwise
# a pinned, checksummed static build, and never apt (#17964). PATH is limited to
# stubs plus a few real tools so the host's own ffmpeg cannot leak in.

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/ci/ensure-ffmpeg.sh"
PINNED_X64_SHA="17c1ae10b52ac499180679fe6ba77e17642390c4eedb0f1e3b0ac045da55128f"

setup() {
  MOCK_BIN="$BATS_TEST_TMPDIR/bin"
  CALLS="$BATS_TEST_TMPDIR/calls"
  CACHE="$BATS_TEST_TMPDIR/cache"
  export CALLS
  mkdir -p "$MOCK_BIN"
  : >"$CALLS"
  local tool
  for tool in bash awk cat chmod dirname gunzip gzip mkdir mktemp mv rm sha256sum; do
    ln -s "$(command -v "$tool")" "$MOCK_BIN/$tool"
  done
  for tool in apt-get sudo; do
    printf '#!/bin/bash\necho "%s $*" >>"$CALLS"\nexit 1\n' "$tool" >"$MOCK_BIN/$tool"
    chmod +x "$MOCK_BIN/$tool"
  done
  printf '#!/bin/bash\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n' >"$MOCK_BIN/uname"
  # Fake release asset: a gzipped shell script standing in for ffmpeg.
  printf '#!/bin/bash\necho "ffmpeg version static-stub"\n' | gzip -c >"$BATS_TEST_TMPDIR/asset.gz"
  cat >"$MOCK_BIN/curl" <<STUB
#!/bin/bash
echo "curl \$*" >>"\$CALLS"
while [ \$# -gt 0 ]; do
  [ "\$1" = "--output" ] && { cp "$BATS_TEST_TMPDIR/asset.gz" "\$2"; exit 0; }
  shift
done
exit 1
STUB
  ln -s "$(command -v cp)" "$MOCK_BIN/cp"
  chmod +x "$MOCK_BIN/uname" "$MOCK_BIN/curl"
}

run_script() {
  run env -i PATH="$MOCK_BIN" CALLS="$CALLS" HOME="$BATS_TEST_TMPDIR" \
    AUTOMOBILE_FFMPEG_CACHE_DIR="$CACHE" GITHUB_PATH="$BATS_TEST_TMPDIR/github_path" \
    bash "$SCRIPT"
}

stub_matching_sha() {
  rm "$MOCK_BIN/sha256sum"
  printf '#!/bin/bash\necho "%s  $1"\n' "$PINNED_X64_SHA" >"$MOCK_BIN/sha256sum"
  chmod +x "$MOCK_BIN/sha256sum"
}

@test "uses an ffmpeg already on PATH without downloading or apt" {
  printf '#!/bin/bash\necho "ffmpeg $*" >>"$CALLS"\n' >"$MOCK_BIN/ffmpeg"
  chmod +x "$MOCK_BIN/ffmpeg"
  run_script
  [ "$status" -eq 0 ]
  [[ "$output" == *"using $MOCK_BIN/ffmpeg"* ]]
  [ ! -s "$CALLS" ]
  [ ! -e "$BATS_TEST_TMPDIR/github_path" ]
}

@test "downloads the pinned static build, verifies it, and adds it to GITHUB_PATH" {
  stub_matching_sha
  run_script
  [ "$status" -eq 0 ]
  grep -q "^curl .*releases/download/b6.0/ffmpeg-linux-x64.gz" "$CALLS"
  ! grep -qE '^(apt-get|sudo) ' "$CALLS"
  [ "$("$CACHE/b6.0/ffmpeg")" = "ffmpeg version static-stub" ]
  [ "$(cat "$BATS_TEST_TMPDIR/github_path")" = "$CACHE/b6.0" ]
  # A cache hit (restored by actions/cache) skips the download.
  : >"$CALLS"
  run_script
  [ "$status" -eq 0 ]
  [ ! -s "$CALLS" ]
}

@test "rejects a download whose checksum does not match the pin" {
  run_script
  [ "$status" -eq 1 ]
  [[ "$output" == *"checksum mismatch for ffmpeg-linux-x64.gz"* ]]
  [ ! -e "$CACHE/b6.0/ffmpeg" ]
  [ ! -e "$BATS_TEST_TMPDIR/github_path" ]
  [ -z "$(ls -A "$CACHE/b6.0")" ]
}

@test "the WebRTC publisher action caches and uses the helper instead of apt" {
  local action="$BATS_TEST_DIRNAME/../../.github/actions/ci-webrtc-publisher-integration/action.yml"
  grep -Fq 'scripts/ci/ensure-ffmpeg.sh' "$action"
  grep -Fq "path: scratch/ffmpeg" "$action"
  grep -Fq "hashFiles('scripts/ci/ensure-ffmpeg.sh')" "$action"
  ! grep -Fq 'install-apt-packages.sh' "$action"
}
