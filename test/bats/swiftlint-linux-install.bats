#!/usr/bin/env bats
#
# The SwiftLint CI job runs on Linux with the official SwiftLint Linux binary
# (#17581). These tests guard that the Linux pin tracks the Mac pin's version,
# that the download is SHA-256 verified before use, and that the installer
# fails closed on a mismatch, a failed download, or an unsupported arch.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  FIXTURE="$(mktemp -d)"
  STUB_DIR="${FIXTURE}/bin"
  PIN_DIR="${FIXTURE}/swiftlint"
  INSTALL_DIR="${FIXTURE}/install"
  mkdir -p "$STUB_DIR" "$PIN_DIR"
  for file in swiftlint_version.sh swiftlint_linux_pin.sh check_swiftlint_pin_consistency.sh install_swiftlint_linux.sh; do
    cp "${REPO_ROOT}/scripts/swiftlint/${file}" "${PIN_DIR}/${file}"
  done

  # A release-shaped archive whose swiftlint prints the pinned version.
  mkdir -p "${FIXTURE}/payload"
  # shellcheck source=scripts/swiftlint/swiftlint_linux_pin.sh
  source "${REPO_ROOT}/scripts/swiftlint/swiftlint_linux_pin.sh"
  printf '#!/usr/bin/env bash\necho %s\n' "$SWIFTLINT_LINUX_VERSION" > "${FIXTURE}/payload/swiftlint"
  chmod +x "${FIXTURE}/payload/swiftlint"
  (cd "${FIXTURE}/payload" && zip -q "${FIXTURE}/release.zip" swiftlint)
  FIXTURE_SHA="$({ sha256sum "${FIXTURE}/release.zip" 2>/dev/null || shasum -a 256 "${FIXTURE}/release.zip"; } | cut -d' ' -f1)"

  # curl stub: records the URL and serves the fixture archive to -o.
  cat > "${STUB_DIR}/curl" <<EOF
#!/usr/bin/env bash
out=""; prev=""
for a in "\$@"; do
  [ "\$prev" = "-o" ] && out="\$a"
  case "\$a" in https://*) echo "\$a" >> "${FIXTURE}/curl.log" ;; esac
  prev="\$a"
done
[ -n "\${CURL_STUB_FAIL:-}" ] && exit 22
cp "${FIXTURE}/release.zip" "\$out"
EOF
  chmod +x "${STUB_DIR}/curl"
}

teardown() {
  rm -rf "$FIXTURE"
}

set_pin() {
  local key="$1" value="$2" file="${3:-swiftlint_linux_pin.sh}"
  sed -i.bak "s|^${key}=.*|${key}=\"${value}\"|" "${PIN_DIR}/${file}"
  rm -f "${PIN_DIR}/${file}.bak"
}

run_installer() {
  run env PATH="${STUB_DIR}:${PATH}" SWIFTLINT_INSTALL_DIR="$INSTALL_DIR" "$@" bash "${PIN_DIR}/install_swiftlint_linux.sh"
}

@test "the committed Linux SwiftLint pin matches the Mac pin" {
  run bash "${REPO_ROOT}/scripts/swiftlint/check_swiftlint_pin_consistency.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"SwiftLint pins agree"* ]]
}

@test "the pin check fails when the Linux and Mac versions diverge" {
  set_pin SWIFTLINT_LINUX_VERSION "0.99.0"
  run bash "${PIN_DIR}/check_swiftlint_pin_consistency.sh" "$PIN_DIR"
  [ "$status" -ne 0 ]
  [[ "$output" == *"SwiftLint pins diverge"* ]]
  [[ "$output" == *"0.99.0"* ]]
}

@test "the pin check fails when only the Mac version is bumped" {
  set_pin SWIFTLINT_VERSION "0.99.0" swiftlint_version.sh
  run bash "${PIN_DIR}/check_swiftlint_pin_consistency.sh" "$PIN_DIR"
  [ "$status" -ne 0 ]
  [[ "$output" == *"SwiftLint pins diverge"* ]]
}

@test "the pin check rejects a malformed SHA-256" {
  set_pin SWIFTLINT_LINUX_SHA256 "not-a-digest"
  run bash "${PIN_DIR}/check_swiftlint_pin_consistency.sh" "$PIN_DIR"
  [ "$status" -ne 0 ]
  [[ "$output" == *"64-character hex SHA-256"* ]]
}

@test "the Fast Validation registry runs the SwiftLint pin check" {
  run grep -F 'add_check "swiftlint-pins" "bash \"$PROJECT_ROOT/scripts/swiftlint/check_swiftlint_pin_consistency.sh\""' "${REPO_ROOT}/scripts/all_fast_validate_checks.sh"
  [ "$status" -eq 0 ]
  run grep -E -- '--only .*,swiftlint-pins,' "${REPO_ROOT}/.github/workflows/pull_request.yml"
  [ "$status" -eq 0 ]
}

@test "the installer installs a download whose SHA-256 matches the pin" {
  [[ "$(uname -m)" == "x86_64" ]] || skip "fixture installs on x86_64 only"
  set_pin SWIFTLINT_LINUX_SHA256 "$FIXTURE_SHA"
  run_installer
  [ "$status" -eq 0 ]
  [[ "$output" == *"Verified SHA-256 ${FIXTURE_SHA}"* ]]
  [ -x "${INSTALL_DIR}/swiftlint" ]
  [ "$("${INSTALL_DIR}/swiftlint")" = "$SWIFTLINT_LINUX_VERSION" ]
  [ "$(cat "${FIXTURE}/curl.log")" = "https://github.com/realm/SwiftLint/releases/download/${SWIFTLINT_LINUX_VERSION}/swiftlint_linux.zip" ]
}

@test "the installer refuses a download whose SHA-256 differs from the pin" {
  [[ "$(uname -m)" == "x86_64" ]] || skip "fixture installs on x86_64 only"
  run_installer
  [ "$status" -ne 0 ]
  [[ "$output" == *"checksum mismatch"* ]]
  [ ! -e "${INSTALL_DIR}/swiftlint" ]
}

@test "the installer fails when the download fails" {
  [[ "$(uname -m)" == "x86_64" ]] || skip "fixture installs on x86_64 only"
  set_pin SWIFTLINT_LINUX_SHA256 "$FIXTURE_SHA"
  run_installer CURL_STUB_FAIL=1
  [ "$status" -ne 0 ]
  [[ "$output" == *"Failed to download SwiftLint"* ]]
  [ ! -e "${INSTALL_DIR}/swiftlint" ]
}

@test "the installer refuses to install when the pins diverge" {
  [[ "$(uname -m)" == "x86_64" ]] || skip "fixture installs on x86_64 only"
  set_pin SWIFTLINT_LINUX_SHA256 "$FIXTURE_SHA"
  set_pin SWIFTLINT_VERSION "0.99.0" swiftlint_version.sh
  run_installer
  [ "$status" -ne 0 ]
  [[ "$output" == *"SwiftLint pins diverge"* ]]
  [ ! -e "${FIXTURE}/curl.log" ]
}

@test "the installer refuses a non-x86_64 Linux host" {
  printf '#!/usr/bin/env bash\necho aarch64\n' > "${STUB_DIR}/uname"
  chmod +x "${STUB_DIR}/uname"
  run_installer
  [ "$status" -ne 0 ]
  [[ "$output" == *"x86_64 only"* ]]
  [ ! -e "${FIXTURE}/curl.log" ]
}

@test "install_swiftlint.sh delegates Linux installs to the pinned installer" {
  run grep -F 'bash "$(dirname "${BASH_SOURCE[0]}")/install_swiftlint_linux.sh"' "${REPO_ROOT}/scripts/swiftlint/install_swiftlint.sh"
  [ "$status" -eq 0 ]
}

@test "Linux SwiftLint finds sourcekitd beside the swift on PATH" {
  local toolchain="${FIXTURE}/toolchain"
  mkdir -p "${toolchain}/usr/bin" "${toolchain}/usr/lib"
  printf '#!/usr/bin/env bash\n' > "${toolchain}/usr/bin/swift"
  chmod +x "${toolchain}/usr/bin/swift"
  touch "${toolchain}/usr/lib/libsourcekitdInProc.so"
  printf '#!/usr/bin/env bash\necho Linux\n' > "${STUB_DIR}/uname"
  chmod +x "${STUB_DIR}/uname"
  # shellcheck disable=SC2016 # Expanded by the child bash.
  run env -u LINUX_SOURCEKIT_LIB_PATH PATH="${STUB_DIR}:${toolchain}/usr/bin:${PATH}" bash -c 'source "$1"; export_linux_sourcekit_lib_path && echo "$LINUX_SOURCEKIT_LIB_PATH"' _ "${PIN_DIR}/swiftlint_version.sh"
  [ "$status" -eq 0 ]
  [ "$output" = "$(cd "${toolchain}/usr/lib" && pwd -P)" ]
}

@test "Linux SwiftLint fails clearly without a Swift toolchain" {
  printf '#!/usr/bin/env bash\necho Linux\n' > "${STUB_DIR}/uname"
  chmod +x "${STUB_DIR}/uname"
  # shellcheck disable=SC2016 # Expanded by the child bash.
  run env -u LINUX_SOURCEKIT_LIB_PATH PATH="${STUB_DIR}:/usr/bin:/bin" bash -c 'command() { if [[ "$1 $2" == "-v swift" ]]; then return 1; fi; builtin command "$@"; }; source "$1"; export_linux_sourcekit_lib_path' _ "${PIN_DIR}/swiftlint_version.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"libsourcekitdInProc.so"* ]]
}
