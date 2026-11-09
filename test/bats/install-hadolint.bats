#!/usr/bin/env bats
#
# Tests for scripts/hadolint/install_hadolint.sh install_manual()
#
# Regression guards for #3641:
#  1. curl must use --fail so an HTTP 404 is a download failure, not a
#     404 error page saved and installed as the "binary".
#  2. macOS/arm64 must map to the published Darwin-x86_64 asset (hadolint
#     ships no Darwin-arm64 build), so the URL does not 404 on Apple Silicon.
# and for #17641: the download goes through release_fetch_pinned, so the binary
# is checksum-verified against hadolint_version.sh, cached, and retried with a
# bounded backoff. sha256sum and sleep are stubbed.

SCRIPT="scripts/hadolint/install_hadolint.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  STUB_DIR="$(mktemp -d)"
  WORK_DIR="$(mktemp -d)"
  unset AUTOMOBILE_TOOL_CACHE_DIR XDG_CACHE_HOME
  export SLEEP_LOG="$WORK_DIR/sleep.log"
  # A stub binary cannot hash to the real pin; report the pin of the asset in
  # the URL being verified unless FAKE_SHA256 models a corrupt download.
  cat > "$STUB_DIR/sha256sum" <<'STUB'
#!/usr/bin/env bash
echo "${FAKE_SHA256:-$PINNED_SHA256}  $1"
STUB
  cat > "$STUB_DIR/sleep" <<'STUB'
#!/usr/bin/env bash
echo "$1" >> "$SLEEP_LOG"
STUB
  chmod +x "$STUB_DIR/sha256sum" "$STUB_DIR/sleep"
}

teardown() {
  rm -rf "$STUB_DIR" "$WORK_DIR"
}

# Run install_manual with stubbed detect_os/detect_arch/curl.
# $1=os $2=arch ; $3="404" makes the stub curl simulate a 404, "504" a 504.
run_install_manual() {
  local os="$1" arch="$2" mode="${3:-ok}"

  # Stub curl: if --fail/-f is present, a 404 exits non-zero and writes
  # nothing; otherwise it "succeeds" and saves an HTML error page.
  cat > "$STUB_DIR/curl" <<EOF
#!/usr/bin/env bash
out=""; prev=""; has_fail=0
for a in "\$@"; do
  case "\$a" in -*f*) [[ "\$a" != --* || "\$a" == --fail ]] && has_fail=1 ;; esac
  [ "\$prev" = "-o" ] && out="\$a"
  prev="\$a"
done
echo "\$*" >> "$WORK_DIR/curl.log"
if [ "$mode" = "504" ]; then
  echo "curl: (22) The requested URL returned error: 504" >&2; exit 22
fi
if [ "$mode" = "404" ]; then
  if [ "\$has_fail" = "1" ]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi
  [ -n "\$out" ] && printf '<html>404: Not Found</html>' > "\$out"
  exit 0
fi
[ -n "\$out" ] && printf '#!/bin/sh\necho fake-hadolint\n' > "\$out"
exit 0
EOF
  chmod +x "$STUB_DIR/curl"

  local asset="hadolint-Darwin-x86_64"
  case "$os" in linux) asset="hadolint-Linux-${arch}" ;; esac
  run env HOME="$WORK_DIR" PATH="$STUB_DIR:$PATH" RELEASE_DOWNLOAD_JITTER=false \
    PINNED_SHA256="$(bash -c 'source "$1"; hadolint_release_sha256 "$2"' _ "$(dirname "$ABS_SCRIPT")/hadolint_version.sh" "$asset")" \
    bash -c '
    source "$(dirname "$1")/hadolint_version.sh"
    source "$(dirname "$1")/../lib/release-download.sh"
    eval "$(awk "/^install_manual\\(\\) \\{/{f=1} f{print} f&&/^\\}/{exit}" "$1")"
    eval "$(awk "/^run_capture_status\\(\\) \\{/{f=1} f{print} f&&/^\\}/{exit}" "$1")"
    detect_os() { echo "'"$os"'"; }
    detect_arch() { echo "'"$arch"'"; }
    command_exists() { [ "$1" = curl ]; }
    RED=""; GREEN=""; YELLOW=""; NC=""
    install_manual
  ' _ "$ABS_SCRIPT"
}

@test "install_manual fails when the download 404s (curl --fail)" {
  run_install_manual macos x86_64 404
  [ "$status" -ne 0 ]
  # The garbage payload must NOT be installed.
  [ ! -f "$WORK_DIR/.local/bin/hadolint" ]
}

@test "install_manual succeeds on a real download" {
  run_install_manual macos x86_64 ok
  [ "$status" -eq 0 ]
  [ -f "$WORK_DIR/.local/bin/hadolint" ]
}

@test "macOS arm64 maps to the published Darwin-x86_64 asset" {
  run_install_manual macos arm64 ok
  [ "$status" -eq 0 ]
  [[ "$output" == *"hadolint-Darwin-x86_64"* ]]
  # The download URL must not reference the nonexistent Darwin-arm64 asset.
  [[ "$output" != *"hadolint-Darwin-arm64"* ]]
}

@test "every hadolint asset either installer can request has a pinned checksum" {
  source "$(dirname "$ABS_SCRIPT")/hadolint_version.sh"
  for asset in hadolint-Linux-x86_64 hadolint-Linux-arm64 hadolint-Darwin-x86_64 hadolint-Windows-x86_64.exe; do
    [[ "$(hadolint_release_sha256 "$asset")" =~ ^[0-9a-f]{64}$ ]]
  done
  [ -z "$(hadolint_release_sha256 hadolint-Darwin-arm64)" ]
}

@test "a download is verified, installed and cached for the next run" {
  run_install_manual linux x86_64 ok
  [ "$status" -eq 0 ]
  [ -x "$WORK_DIR/.local/bin/hadolint" ]
  ls "$WORK_DIR"/.cache/auto-mobile/tools/hadolint/2.12.0/*/hadolint-Linux-x86_64
  # A second install reuses the cache even while GitHub returns 504.
  rm -f "$WORK_DIR/.local/bin/hadolint" "$WORK_DIR/curl.log"
  run_install_manual linux x86_64 504
  [ "$status" -eq 0 ]
  [[ "$output" == *"Using cached hadolint-Linux-x86_64"* ]]
  [ ! -e "$WORK_DIR/curl.log" ]
}

@test "a GitHub 504 is retried with backoff and reported as an upstream failure" {
  RELEASE_DOWNLOAD_ATTEMPTS=3 run_install_manual linux x86_64 504
  [ "$status" -ne 0 ]
  [ "$(wc -l < "$WORK_DIR/curl.log" | tr -d ' ')" -eq 3 ]
  [ "$(paste -sd' ' "$SLEEP_LOG")" = "3 6" ]
  [[ "$output" == *"UPSTREAM-DOWNLOAD-FAILURE: https://github.com/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-x86_64 failed after 3 attempts"* ]]
  [ ! -e "$WORK_DIR/.local/bin/hadolint" ]
}

@test "a downloaded binary whose checksum differs from the pin is rejected" {
  FAKE_SHA256=deadbeef run_install_manual linux x86_64 ok
  [ "$status" -ne 0 ]
  [[ "$output" == *"Checksum mismatch"* ]]
  [ ! -e "$WORK_DIR/.local/bin/hadolint" ]
}
