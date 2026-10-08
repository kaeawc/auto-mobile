#!/usr/bin/env bats
#
# scripts/ios/build-overlay-agent.sh with the Apple toolchain stubbed out: the
# test proves orchestration (both simulator slices, lipo, ad-hoc sign, atomic
# output), not the compiler.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/ios/build-overlay-agent.sh"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  CALLS="${BATS_TEST_TMPDIR}/calls.log"
  SRC_ROOT="${BATS_TEST_TMPDIR}/Sources"
  SRC_DIR="${SRC_ROOT}/AutoMobileOverlayAgent"
  CALLER_DIR="${BATS_TEST_TMPDIR}/caller"
  mkdir -p "${MOCK_BIN}" "${SRC_DIR}" "${SRC_ROOT}/AutoMobileOverlayAgentCore" "${CALLER_DIR}"
  : > "${CALLS}"
  printf 'int x;\n' > "${SRC_DIR}/Loader.c"
  printf 'let a = 1\n' > "${SRC_DIR}/A.swift"
  printf 'let b = 2\n' > "${SRC_ROOT}/AutoMobileOverlayAgentCore/B.swift"

  # xcrun: --show-sdk-path prints a fake SDK; clang/swiftc record the call and
  # create the file named by -o.
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/usr/bin/env bash
echo "xcrun $*" >> "${CALLS}"
if [[ "$*" == *"--show-sdk-path"* ]]; then
  echo "/fake/iPhoneSimulator.sdk"
  exit 0
fi
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out="$2"; fi
  shift
done
[[ -n "${out}" ]] && printf 'obj\n' > "${out}"
exit 0
SCRIPT
  cat > "${MOCK_BIN}/lipo" <<'SCRIPT'
#!/usr/bin/env bash
echo "lipo $*" >> "${CALLS}"
if [[ "$1" == "-archs" ]]; then
  echo "${LIPO_TEST_ARCHS:-arm64 x86_64}"
  exit 0
fi
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-output" ]]; then out="$2"; fi
  shift
done
printf 'fat\n' > "${out}"
SCRIPT
  cat > "${MOCK_BIN}/codesign" <<'SCRIPT'
#!/usr/bin/env bash
echo "codesign $*" >> "${CALLS}"
SCRIPT
  chmod +x "${MOCK_BIN}/"{xcrun,lipo,codesign}

  export CALLS
  export PATH="${MOCK_BIN}:${PATH}"
  export OVERLAY_AGENT_SOURCES_ROOT="${SRC_ROOT}"
}

@test "builds both simulator slices, lipos them, and ad-hoc signs" {
  run bash -c 'cd "$1" && "$2" out/agent.dylib' _ "${CALLER_DIR}" "${SCRIPT}"

  [ "${status}" -eq 0 ]
  [ -f "${CALLER_DIR}/out/agent.dylib" ]
  [ ! -e "${CALLER_DIR}/out/agent.dylib.partial" ]
  [[ "${output}" == *"/out/agent.dylib" ]]
  grep -Fq -- "-target arm64-apple-ios17.0-simulator" "${CALLS}"
  grep -Fq -- "-target x86_64-apple-ios17.0-simulator" "${CALLS}"
  [ "$(grep -c 'iphonesimulator swiftc' "${CALLS}")" -eq 2 ]
  [ "$(grep -c 'iphonesimulator clang' "${CALLS}")" -eq 2 ]
  grep -Fq "lipo -create" "${CALLS}"
  grep -Fq "codesign --force --sign -" "${CALLS}"
  # Sources from the app and core directories are passed to every swiftc invocation.
  [ "$(grep 'iphonesimulator swiftc' "${CALLS}" | grep -c 'A.swift.*B.swift')" -eq 2 ]
}

@test "honors OVERLAY_AGENT_MIN_IOS" {
  OVERLAY_AGENT_MIN_IOS="16.4" run bash -c 'cd "$1" && "$2" agent.dylib' _ "${CALLER_DIR}" "${SCRIPT}"

  [ "${status}" -eq 0 ]
  grep -Fq -- "-target arm64-apple-ios16.4-simulator" "${CALLS}"
  grep -Fq -- "-target x86_64-apple-ios16.4-simulator" "${CALLS}"
}

@test "fails and leaves no output when a slice is missing from the fat file" {
  LIPO_TEST_ARCHS="arm64" run bash -c 'cd "$1" && "$2" agent.dylib' _ "${CALLER_DIR}" "${SCRIPT}"

  [ "${status}" -eq 1 ]
  [[ "${output}" == *"missing x86_64"* ]]
  [ ! -e "${CALLER_DIR}/agent.dylib" ]
  [ ! -e "${CALLER_DIR}/agent.dylib.partial" ]
  # Slices are signed by the shared build script; the fat output must not be.
  ! grep -Fq "codesign --force --sign - ${CALLER_DIR}" "${CALLS}"
}

@test "fails when there are no Swift sources" {
  rm -f "${SRC_DIR}"/*.swift "${SRC_ROOT}"/*/*.swift

  run bash -c 'cd "$1" && "$2" agent.dylib' _ "${CALLER_DIR}" "${SCRIPT}"

  [ "${status}" -eq 1 ]
  [[ "${output}" == *"No Swift sources"* ]]
}
