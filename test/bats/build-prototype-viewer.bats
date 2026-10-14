#!/usr/bin/env bats
# Release wrapper in an isolated fixture checkout; no Apple tools run for real.
setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  FIXTURE="${BATS_TEST_TMPDIR}/repo"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${FIXTURE}/scripts/ios" "${MOCK_BIN}"
  cp "${REPO_ROOT}/scripts/ios/build-prototype-viewer-release.sh" "${FIXTURE}/scripts/ios/"
  SCRIPT="${FIXTURE}/scripts/ios/build-prototype-viewer-release.sh"
  export BUILD_LOG="${BATS_TEST_TMPDIR}/build.log"
  cat > "${FIXTURE}/scripts/ios/prototype-viewer-build.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" > "$BUILD_LOG"
case "${BUILD_TEST_FAILURE:-}" in
  tool) echo 'missing xcrun' >&2; exit 1 ;;
  arch) echo 'missing x86_64 slice' >&2; exit 1 ;;
  signature) echo 'signature failed' >&2; exit 1 ;;
esac
mkdir -p "$1/PrototypeViewer.app"
printf 'executable\n' > "$1/PrototypeViewer.app/PrototypeViewer"
chmod +x "$1/PrototypeViewer.app/PrototypeViewer"
printf 'signature\n' > "$1/PrototypeViewer.app/signature"
SCRIPT
  cat > "${MOCK_BIN}/ditto" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $3" == '-c -k --keepParent' ]]
[[ "$(basename "$4")" == PrototypeViewer.app ]]
[[ -x "$4/PrototypeViewer" && -s "$4/signature" ]]
[[ "${BUILD_TEST_FAILURE:-}" != archive ]] || exit 1
printf 'archive\n' > "$5"
SCRIPT
  chmod +x "${MOCK_BIN}/ditto"
  export PATH="${MOCK_BIN}:${PATH}"
}

@test "packages only the signed app with keepParent and resolves a relative output" {
  mkdir -p "${BATS_TEST_TMPDIR}/caller"
  run bash -c 'cd "$1" && bash "$2" "out space/viewer.zip"' _ "${BATS_TEST_TMPDIR}/caller" "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -s "${BATS_TEST_TMPDIR}/caller/out space/viewer.zip" ]
  [[ "$output" == *'/out space/viewer.zip' ]]
  [ ! -e "$(cat "$BUILD_LOG")" ]
}

@test "propagates missing build tool, architecture, signature and archive failures and cleans scratch" {
  for failure in tool arch signature archive; do
    BUILD_TEST_FAILURE="$failure" run bash "$SCRIPT" "${BATS_TEST_TMPDIR}/viewer.zip"
    [ "$status" -ne 0 ]
    [ ! -e "${BATS_TEST_TMPDIR}/viewer.zip" ]
    [ ! -e "$(cat "$BUILD_LOG")" ]
  done
}

@test "rejects a missing ditto before building" {
  printf '#!/usr/bin/env bash\nexit 1\n' > "${MOCK_BIN}/ditto"
  # A restricted PATH contains bash and dirname, but no ditto.
  rm "${MOCK_BIN}/ditto"
  ln -s "$(command -v bash)" "${MOCK_BIN}/bash"
  ln -s "$(command -v dirname)" "${MOCK_BIN}/dirname"
  run env PATH="${MOCK_BIN}" bash "$SCRIPT" "${BATS_TEST_TMPDIR}/viewer.zip"
  [ "$status" -ne 0 ]
  [[ "$output" == *'ditto is required'* ]]
  [ ! -e "$BUILD_LOG" ]
}

@test "requires an output archive path" {
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'Usage:'* ]]
}
