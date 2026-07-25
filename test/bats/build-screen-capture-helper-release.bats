#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/ios/build-screen-capture-helper-release.sh"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  SWIFT_BIN="${BATS_TEST_TMPDIR}/swift-bin"
  CALLER_DIR="${BATS_TEST_TMPDIR}/caller"
  mkdir -p "${MOCK_BIN}" "${SWIFT_BIN}" "${CALLER_DIR}"
  touch "${SWIFT_BIN}/screen-capture-helper"

  cat > "${MOCK_BIN}/swift" <<'SCRIPT'
#!/usr/bin/env bash
if [[ "$*" == *"--show-bin-path"* ]]; then
  printf '%s\n' "${SCREEN_CAPTURE_HELPER_TEST_SWIFT_BIN}"
fi
SCRIPT
  cat > "${MOCK_BIN}/lipo" <<'SCRIPT'
#!/usr/bin/env bash
printf 'arm64 x86_64\n'
SCRIPT
  cat > "${MOCK_BIN}/codesign" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  cat > "${MOCK_BIN}/ditto" <<'SCRIPT'
#!/usr/bin/env bash
archive_path="${!#}"
mkdir -p "$(dirname "${archive_path}")"
printf 'archive\n' > "${archive_path}"
SCRIPT
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  chmod +x "${MOCK_BIN}/"{swift,lipo,codesign,ditto,xcrun}

  export PATH="${MOCK_BIN}:${PATH}"
  export SCREEN_CAPTURE_HELPER_TEST_SWIFT_BIN="${SWIFT_BIN}"
  export MACOS_DEVELOPER_ID_SIGNING_IDENTITY="Developer ID"
  export APPLE_NOTARY_KEY_ID="key-id"
  export APPLE_NOTARY_ISSUER_ID="issuer-id"
  export APPLE_NOTARY_KEY_PATH="${BATS_TEST_TMPDIR}/notary-key.p8"
}

@test "writes a relative archive path relative to the caller" {
  run bash -c 'cd "$1" && "$2" "$3"' _ \
    "${CALLER_DIR}" "${SCRIPT}" "artifacts/screen-capture-helper.zip"

  [ "${status}" -eq 0 ]
  [ -f "${CALLER_DIR}/artifacts/screen-capture-helper.zip" ]
}
