#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Tests for scripts/lychee/install_lychee.sh's pinned release install (#17641):
# checksum-verified cache reuse, bounded retry on a GitHub release 5xx with the
# upstream-failure marker, and the per-asset checksum pin. uname, curl,
# sha256sum, sleep and apt-get are stubbed and PATH is limited to system
# directories, so nothing touches the network, the real HOME, or a lychee the
# host already has installed.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/lychee/install_lychee.sh"
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  unset AUTOMOBILE_TOOL_CACHE_DIR XDG_CACHE_HOME GITHUB_PATH
  export CURL_LOG="$BATS_TEST_TMPDIR/curl.log"
  export SLEEP_LOG="$BATS_TEST_TMPDIR/sleep.log"
  : > "$CURL_LOG"
  : > "$SLEEP_LOG"

  # shellcheck source=scripts/lychee/lychee_version.sh
  source "$REPO_ROOT/scripts/lychee/lychee_version.sh"
  ASSET="lychee-x86_64-unknown-linux-gnu.tar.gz"
  export PINNED_SHA256
  PINNED_SHA256="$(lychee_release_sha256 "$ASSET")"
  CACHE_DIR="$HOME/.cache/auto-mobile/tools/lychee/${LYCHEE_VERSION}/${PINNED_SHA256}"
  ASSET_URL="https://github.com/lycheeverse/lychee/releases/download/lychee-v${LYCHEE_VERSION}/${ASSET}"

  # A release-shaped archive (binary at the root, plus docs/) whose lychee
  # prints the pinned version.
  export FAKE_ARCHIVE="$BATS_TEST_TMPDIR/$ASSET"
  local src="$BATS_TEST_TMPDIR/archive-src"
  mkdir -p "$src/docs"
  printf '#!/bin/sh\necho "lychee %s"\n' "$LYCHEE_VERSION" > "$src/lychee"
  chmod +x "$src/lychee"
  : > "$src/docs/README.md"
  tar -czf "$FAKE_ARCHIVE" -C "$src" lychee docs

  cat > "$STUB_BIN/uname" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "-m" ]]; then echo "${UNAME_M:-x86_64}"; else echo Linux; fi
STUB
  cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
out="" prev=""
for a in "$@"; do
  [[ "$prev" == "-o" ]] && out="$a"
  prev="$a"
done
echo "$*" >> "$CURL_LOG"
if [[ -n "${CURL_FAIL_HTTP:-}" ]]; then
  echo "curl: (22) The requested URL returned error: ${CURL_FAIL_HTTP}" >&2
  exit 22
fi
cp "$FAKE_ARCHIVE" "$out"
STUB
  # A fixture archive cannot hash to the real pin; report the pin unless
  # FAKE_SHA256 models a corrupt asset.
  cat > "$STUB_BIN/sha256sum" <<'STUB'
#!/usr/bin/env bash
echo "${FAKE_SHA256:-$PINNED_SHA256}  $1"
STUB
  cat > "$STUB_BIN/sleep" <<'STUB'
#!/usr/bin/env bash
echo "$1" >> "$SLEEP_LOG"
STUB
  # An apt host takes the pinned manual install, as the CI runners do; it also
  # keeps a host pacman/nix from being tried.
  cat > "$STUB_BIN/apt-get" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$STUB_BIN"/*
  # System directories only, so a host lychee (Homebrew, ~/.local/bin, the CI
  # runner's install) cannot short-circuit the installer.
  export PATH="$STUB_BIN:/usr/bin:/bin"
}

@test "every lychee asset the installer can request has a pinned checksum" {
  for asset in lychee-arm64-macos.tar.gz lychee-x86_64-unknown-linux-gnu.tar.gz \
    lychee-aarch64-unknown-linux-gnu.tar.gz lychee-armv7-unknown-linux-gnueabihf.tar.gz \
    lychee-x86_64-windows.exe; do
    [[ "$(lychee_release_sha256 "$asset")" =~ ^[0-9a-f]{64}$ ]]
  done
  ! lychee_release_sha256 lychee-riscv64-unknown-linux-gnu.tar.gz
}

@test "every asset name in the installer has a pinned checksum" {
  local names
  names="$(grep -oE 'binary_name="lychee-[^"]+"' "$SCRIPT" | cut -d'"' -f2 | sort -u)"
  [ -n "$names" ]
  while IFS= read -r name; do
    lychee_release_sha256 "$name" > /dev/null
  done <<< "$names"
}

@test "a cached archive with the pinned checksum installs without downloading" {
  mkdir -p "$CACHE_DIR"
  cp "$FAKE_ARCHIVE" "$CACHE_DIR/$ASSET"
  run env CURL_FAIL_HTTP=504 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -s "$CURL_LOG" ]
  [[ "$output" == *"Using cached $ASSET"* ]]
  [ -x "$HOME/.local/bin/lychee" ]
  [[ "$output" == *"lychee ${LYCHEE_VERSION}"* ]]
}

@test "a cached archive whose checksum no longer matches is discarded and re-downloaded" {
  mkdir -p "$CACHE_DIR"
  echo corrupt > "$CACHE_DIR/$ASSET"
  cat > "$STUB_BIN/sha256sum" <<'STUB'
#!/usr/bin/env bash
if grep -q corrupt "$1" 2> /dev/null; then echo "deadbeef  $1"; else echo "$PINNED_SHA256  $1"; fi
STUB
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Discarding cached $ASSET"* ]]
  grep -qF "$ASSET_URL" "$CURL_LOG"
  [ -x "$HOME/.local/bin/lychee" ]
}

@test "a download is verified, installed and cached for the next run" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qF "$ASSET_URL" "$CURL_LOG"
  [ -x "$HOME/.local/bin/lychee" ]
  [ -s "$CACHE_DIR/$ASSET" ]
  [[ "$output" == *"Installation completed successfully!"* ]]
}

@test "a GitHub 504 is retried with backoff and reported as an upstream failure" {
  run env CURL_FAIL_HTTP=504 RELEASE_DOWNLOAD_ATTEMPTS=4 RELEASE_DOWNLOAD_JITTER=false bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(wc -l < "$CURL_LOG" | tr -d ' ')" -eq 4 ]
  [ "$(paste -sd' ' "$SLEEP_LOG")" = "3 6 12" ]
  [[ "$output" == *"UPSTREAM-DOWNLOAD-FAILURE: ${ASSET_URL} failed after 4 attempts"* ]]
  [[ "$output" == *"Installation failed!"* ]]
  [ ! -e "$HOME/.local/bin/lychee" ]
}

@test "a 404 fails at once without the upstream-failure marker" {
  run env CURL_FAIL_HTTP=404 bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(wc -l < "$CURL_LOG" | tr -d ' ')" -eq 1 ]
  [[ "$output" != *"UPSTREAM-DOWNLOAD-FAILURE"* ]]
  [ ! -e "$HOME/.local/bin/lychee" ]
}

@test "a downloaded archive whose checksum differs from the pin is rejected" {
  run env FAKE_SHA256=deadbeef bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Checksum mismatch"* ]]
  [ ! -e "$HOME/.local/bin/lychee" ]
  [ ! -e "$CACHE_DIR/$ASSET" ]
}

@test "the GitHub-release lychee steps restore the pinned lychee cache" {
  local workflow
  for workflow in pull_request.yml merge.yml; do
    grep -qF "path: ~/.cache/auto-mobile/tools/lychee" "$REPO_ROOT/.github/workflows/$workflow"
    grep -qF "hashFiles('scripts/lychee/lychee_version.sh')" "$REPO_ROOT/.github/workflows/$workflow"
  done
}
