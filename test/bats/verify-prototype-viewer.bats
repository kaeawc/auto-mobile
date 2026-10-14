#!/usr/bin/env bats
# Apple archive/architecture/plist/signing commands are stubbed; never boots a simulator.
setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/ci/verify-prototype-viewer.sh"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  ARCHIVE="${BATS_TEST_TMPDIR}/viewer.zip"
  mkdir -p "$MOCK_BIN"
  printf 'archive\n' > "$ARCHIVE"
  cat > "${MOCK_BIN}/ditto" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == '-x -k' ]]
[[ "${VERIFY_TEST_FAILURE:-}" != extraction ]] || exit 1
app="$4/PrototypeViewer.app"
mkdir -p "$app"
printf 'binary\n' > "$app/PrototypeViewer"
chmod +x "$app/PrototypeViewer"
case "${VERIFY_TEST_FAILURE:-}" in
  extra) touch "$4/.extra" ;;
  layout) mv "$app" "$4/Other.app" ;;
  executable) chmod -x "$app/PrototypeViewer" ;;
  Assets.car|InfoPlist.strings) mkdir -p "$app/en.lproj"; touch "$app/en.lproj/$VERIFY_TEST_FAILURE" ;;
esac
SCRIPT
  cat > "${MOCK_BIN}/lipo" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $3" == '-verify_arch arm64 x86_64' ]]
[[ "${VERIFY_TEST_FAILURE:-}" != arch ]] || { echo 'missing x86_64 slice' >&2; exit 1; }
SCRIPT
  cat > "${MOCK_BIN}/plutil" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == -extract ]]; then
  echo "${VERIFY_TEST_MINOS:-17.0}"
else
  [[ "$1 $2 $3 $4" == '-convert xml1 -o -' ]]
  if [[ "${VERIFY_TEST_FAILURE:-}" == icon ]]; then
    printf '<plist version="1.0"><dict><key>CFBundleIcons</key><dict><key>CFBundleIconName</key><string>icon</string></dict></dict></plist>'
  else
    printf '<plist version="1.0"><dict/></plist>'
  fi
fi
SCRIPT
  cat > "${MOCK_BIN}/codesign" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == --verify ]]; then
  [[ "${VERIFY_TEST_SIGNATURE:-adhoc}" != none ]] || { echo 'invalid signature' >&2; exit 1; }
else
  echo "Signature=${VERIFY_TEST_SIGNATURE:-adhoc}" >&2
fi
SCRIPT
  chmod +x "${MOCK_BIN}/"{ditto,lipo,plutil,codesign}
  export PATH="${MOCK_BIN}:${PATH}"
}

@test "accepts a universal ad-hoc-signed viewer archive" {
  run bash "$SCRIPT" "$ARCHIVE"
  [ "$status" -eq 0 ]
  [[ "$output" == *'Prototype viewer verified'* ]]
}

@test "rejects missing architecture, bad layout, extraction failure and missing executable mode" {
  for failure in arch extra layout extraction executable; do
    VERIFY_TEST_FAILURE="$failure" run bash "$SCRIPT" "$ARCHIVE"
    [ "$status" -ne 0 ]
  done
}

@test "rejects an unexpected minimum OS and honors argument and environment overrides" {
  VERIFY_TEST_MINOS=16.4 run bash "$SCRIPT" "$ARCHIVE"
  [ "$status" -ne 0 ]
  [[ "$output" == *"MinimumOSVersion must be 17.0"* ]]
  VERIFY_TEST_MINOS=16.4 run bash "$SCRIPT" "$ARCHIVE" 16.4
  [ "$status" -eq 0 ]
  VERIFY_TEST_MINOS=16.4 PROTOTYPE_VIEWER_MIN_IOS=16.4 run bash "$SCRIPT" "$ARCHIVE"
  [ "$status" -eq 0 ]
}

@test "rejects invalid and non-ad-hoc signatures" {
  for signature in none 'Developer ID'; do
    VERIFY_TEST_SIGNATURE="$signature" run bash "$SCRIPT" "$ARCHIVE"
    [ "$status" -ne 0 ]
    [[ "$output" == *signature* ]]
  done
}

@test "rejects compiled resources and a nested CFBundleIconName" {
  for failure in Assets.car InfoPlist.strings icon; do
    VERIFY_TEST_FAILURE="$failure" run bash "$SCRIPT" "$ARCHIVE"
    [ "$status" -ne 0 ]
    [[ "$output" == *'must not contain'* ]]
  done
}

@test "rejects a missing tool" {
  rm "${MOCK_BIN}/ditto"
  ln -s "$(command -v bash)" "${MOCK_BIN}/bash"
  run env PATH="$MOCK_BIN" bash "$SCRIPT" "$ARCHIVE"
  [ "$status" -ne 0 ]
  [[ "$output" == *'ditto is required'* ]]
}

@test "rejects a missing archive and missing argument" {
  run bash "$SCRIPT" "${BATS_TEST_TMPDIR}/missing.zip"
  [ "$status" -ne 0 ]
  [[ "$output" == *'not found or empty'* ]]
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'Usage:'* ]]
}
