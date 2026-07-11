#!/usr/bin/env bats
#
# Tests for scripts/hadolint/install_hadolint.sh install_manual()
#
# Regression guards for #3641:
#  1. curl must use --fail so an HTTP 404 is a download failure, not a
#     404 error page saved and installed as the "binary".
#  2. macOS/arm64 must map to the published Darwin-x86_64 asset (hadolint
#     ships no Darwin-arm64 build), so the URL does not 404 on Apple Silicon.

SCRIPT="scripts/hadolint/install_hadolint.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  STUB_DIR="$(mktemp -d)"
  WORK_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$STUB_DIR" "$WORK_DIR"
}

# Run install_manual with stubbed detect_os/detect_arch/curl.
# $1=os $2=arch ; $3="404" makes the stub curl simulate a 404.
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
if [ "$mode" = "404" ]; then
  if [ "\$has_fail" = "1" ]; then echo "curl: (22) 404 Not Found" >&2; exit 22; fi
  [ -n "\$out" ] && printf '<html>404: Not Found</html>' > "\$out"
  exit 0
fi
[ -n "\$out" ] && printf '#!/bin/sh\necho fake-hadolint\n' > "\$out"
exit 0
EOF
  chmod +x "$STUB_DIR/curl"

  run env HOME="$WORK_DIR" PATH="$STUB_DIR:$PATH" bash -c '
    eval "$(grep "^HADOLINT_VERSION=" "$1")"
    eval "$(awk "/^install_manual\\(\\) \\{/{f=1} f{print} f&&/^\\}/{exit}" "$1")"
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
