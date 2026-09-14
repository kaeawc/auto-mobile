#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/ios/build-network-filter-probe.sh"
  mkdir -p "${BATS_TEST_TMPDIR}/bin"
  cat > "${BATS_TEST_TMPDIR}/bin/swift" <<'MOCK'
#!/usr/bin/env bash
touch "${PROBE_TEST_BUILD_MARKER}"
exit 99
MOCK
  chmod +x "${BATS_TEST_TMPDIR}/bin/swift"
  export PATH="${BATS_TEST_TMPDIR}/bin:${PATH}"
  export PROBE_TEST_BUILD_MARKER="${BATS_TEST_TMPDIR}/build-started"
  export MACOS_DEVELOPER_ID_SIGNING_IDENTITY="test identity"
  export MACOS_DEVELOPER_ID_TEAM_ID="ABCDE12345"
  unset MACOS_PROBE_CONTROLLER_PROFILE MACOS_PROBE_PROVIDER_PROFILE
}

@test "unknown packaging mode fails before building" {
  run bash "${SCRIPT}" install
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"Usage:"* ]]
  [ ! -e "${PROBE_TEST_BUILD_MARKER}" ]
}

@test "signed build requires containing app provisioning before building" {
  run bash "${SCRIPT}" signed
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"containing-app Developer ID provisioning profile is required"* ]]
  [ ! -e "${PROBE_TEST_BUILD_MARKER}" ]
}

@test "signed build rejects missing provider profile file before building" {
  export MACOS_PROBE_CONTROLLER_PROFILE="${BATS_TEST_TMPDIR}/app.provisionprofile"
  export MACOS_PROBE_PROVIDER_PROFILE="${BATS_TEST_TMPDIR}/missing.provisionprofile"
  touch "${MACOS_PROBE_CONTROLLER_PROFILE}"
  run bash "${SCRIPT}" signed
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"Provisioning profile does not exist:"* ]]
  [ ! -e "${PROBE_TEST_BUILD_MARKER}" ]
}

@test "invalid team identifier cannot reach property-list commands" {
  export MACOS_DEVELOPER_ID_TEAM_ID="invalid team"
  run bash "${SCRIPT}" unsigned
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"ten-character Apple team identifier"* ]]
  [ ! -e "${PROBE_TEST_BUILD_MARKER}" ]
}

# --- universal (arm64 + x86_64) slices, #6897 --------------------------------

install_build_stubs() {
  export PROBE_TEST_SWIFT_LOG="${BATS_TEST_TMPDIR}/swift.log"
  export PROBE_TEST_LIPO_LOG="${BATS_TEST_TMPDIR}/lipo.log"
  export PROBE_TEST_BIN_ROOT="${BATS_TEST_TMPDIR}/swift-bin"
  export PROBE_TEST_CODESIGN_MARKER="${BATS_TEST_TMPDIR}/codesign-called"
  export PROBE_OUTPUT_ROOT="${BATS_TEST_TMPDIR}/scratch"
  export PLIST_BUDDY="${BATS_TEST_TMPDIR}/bin/PlistBuddy"
  # swift: records every invocation; a build drops one single-arch executable
  # pair (whose content names the slice) under a per-arch bin path.
  cat > "${BATS_TEST_TMPDIR}/bin/swift" <<'MOCK'
#!/usr/bin/env bash
touch "${PROBE_TEST_BUILD_MARKER}"
printf '%s\n' "$*" >> "${PROBE_TEST_SWIFT_LOG}"
arch=""
prev=""
for arg in "$@"; do
  if [[ "${prev}" == --arch ]]; then arch="${arg}"; fi
  prev="${arg}"
done
bin="${PROBE_TEST_BIN_ROOT}/${arch:-host}"
case " $* " in
  *" --show-bin-path "*) echo "${bin}" ;;
  *)
    mkdir -p "${bin}"
    echo "${arch:-host}" > "${bin}/network-filter-controller"
    echo "${arch:-host}" > "${bin}/network-filter-provider"
    ;;
esac
MOCK
  # lipo: -create concatenates the slice files; -archs lists the slices found
  # (or PROBE_TEST_LIPO_ARCHS, to simulate a build that dropped a slice).
  cat > "${BATS_TEST_TMPDIR}/bin/lipo" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PROBE_TEST_LIPO_LOG}"
if [[ "$1" == -archs ]]; then
  if [[ -n "${PROBE_TEST_LIPO_ARCHS:-}" ]]; then
    echo "${PROBE_TEST_LIPO_ARCHS}"
  else
    tr '\n' ' ' < "$2" | sed 's/ $//'
    echo
  fi
  exit 0
fi
out=""
inputs=""
prev=""
for arg in "$@"; do
  if [[ "${prev}" == -output ]]; then
    out="${arg}"
  elif [[ "${arg}" != -create && "${arg}" != -output ]]; then
    inputs="${inputs} ${arg}"
  fi
  prev="${arg}"
done
# shellcheck disable=SC2086
cat ${inputs} > "${out}"
MOCK
  cat > "${BATS_TEST_TMPDIR}/bin/codesign" <<'MOCK'
#!/usr/bin/env bash
touch "${PROBE_TEST_CODESIGN_MARKER}"
MOCK
  printf '#!/usr/bin/env bash\nexit 0\n' > "${PLIST_BUDDY}"
  chmod +x "${BATS_TEST_TMPDIR}/bin/swift" "${BATS_TEST_TMPDIR}/bin/lipo" \
    "${BATS_TEST_TMPDIR}/bin/codesign" "${PLIST_BUDDY}"
}

@test "unsigned build requests both arm64 and x86_64 slices and lipo-combines them" {
  install_build_stubs
  run bash "${SCRIPT}" unsigned
  [ "${status}" -eq 0 ]
  swift_log="$(cat "${PROBE_TEST_SWIFT_LOG}")"
  [[ "${swift_log}" == *"-c release --arch arm64 -Xswiftc -warnings-as-errors"* ]]
  [[ "${swift_log}" == *"-c release --arch x86_64 -Xswiftc -warnings-as-errors"* ]]
  [[ "${swift_log}" == *"--arch arm64 --show-bin-path"* ]]
  [[ "${swift_log}" == *"--arch x86_64 --show-bin-path"* ]]
  lipo_log="$(cat "${PROBE_TEST_LIPO_LOG}")"
  for executable in network-filter-controller network-filter-provider; do
    [[ "${lipo_log}" == *"-create "*"/slices/arm64/${executable} "*"/slices/x86_64/${executable} -output "*"/slices/universal/${executable}"* ]]
    [[ "${lipo_log}" == *"-archs "*"/slices/universal/${executable}"* ]]
    [[ "${output}" == *"${executable}: arm64 x86_64"* ]]
  done
  app="${lines[${#lines[@]}-1]}"
  [[ "${app}" == "${PROBE_OUTPUT_ROOT}/network-filter-probe."*"/AutoMobile Network Identity Probe.app" ]]
  [ "$(tr '\n' ' ' < "${app}/Contents/MacOS/network-filter-controller")" = "arm64 x86_64 " ]
  provider="${app}/Contents/Library/SystemExtensions/dev.jasonpearson.automobile.networkfilter.provider.systemextension"
  [ "$(tr '\n' ' ' < "${provider}/Contents/MacOS/network-filter-provider")" = "arm64 x86_64 " ]
}

@test "signed build refuses to sign when a slice is missing from the combined executable" {
  install_build_stubs
  export MACOS_PROBE_CONTROLLER_PROFILE="${BATS_TEST_TMPDIR}/app.provisionprofile"
  export MACOS_PROBE_PROVIDER_PROFILE="${BATS_TEST_TMPDIR}/provider.provisionprofile"
  touch "${MACOS_PROBE_CONTROLLER_PROFILE}" "${MACOS_PROBE_PROVIDER_PROFILE}"
  export PROBE_TEST_LIPO_ARCHS="arm64"
  run bash "${SCRIPT}" signed
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"network-filter-controller is missing the x86_64 slice (lipo -archs: arm64)"* ]]
  [ ! -e "${PROBE_TEST_CODESIGN_MARKER}" ]
}

# --- activate exit codes, #6897 ------------------------------------------------

install_controller_stub() {
  # $1 = JSON the controller prints, $2 = its exit code
  export PROBE_TEST_APP="${BATS_TEST_TMPDIR}/Probe.app"
  mkdir -p "${PROBE_TEST_APP}/Contents/MacOS"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'printf '"'"'%%s\\n'"'"' '"'"'%s'"'"'\n' "$1"
    printf 'exit %s\n' "$2"
  } > "${PROBE_TEST_APP}/Contents/MacOS/network-filter-controller"
  chmod +x "${PROBE_TEST_APP}/Contents/MacOS/network-filter-controller"
}

@test "activate exits 0 when the controller reports ready" {
  install_controller_stub '{"state":"ready","detail":"Allow-only provider replied"}' 0
  run bash "${SCRIPT}" activate "${PROBE_TEST_APP}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'"state":"ready"'* ]]
}

@test "activate exits 3 when activation still requires user approval" {
  install_controller_stub '{"state":"approval_required","detail":"Approve AutoMobile Network Identity Probe in System Settings, then run activate again."}' 0
  run bash "${SCRIPT}" activate "${PROBE_TEST_APP}"
  [ "${status}" -eq 3 ]
  [[ "${output}" == *'"state":"approval_required"'* ]]
  [[ "${output}" == *"requires user approval"* ]]
}

@test "activate exits 4 when the extension installs only after a macOS restart" {
  install_controller_stub '{"state":"approval_required","detail":"Extension installation will finish after restarting macOS."}' 0
  run bash "${SCRIPT}" activate "${PROBE_TEST_APP}"
  [ "${status}" -eq 4 ]
  [[ "${output}" == *"requires a macOS restart"* ]]
}

@test "activate forwards the controller's own nonzero exit for unavailable" {
  install_controller_stub '{"state":"unavailable","detail":"Operation timed out"}' 1
  run bash "${SCRIPT}" activate "${PROBE_TEST_APP}"
  [ "${status}" -eq 1 ]
  [[ "${output}" == *'"state":"unavailable"'* ]]
}

@test "activate never reports success for a non-ready state that exited 0" {
  install_controller_stub '{"state":"installation_required","detail":"x"}' 0
  run bash "${SCRIPT}" activate "${PROBE_TEST_APP}"
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"without reporting ready (state: installation_required)"* ]]
}

@test "activate rejects a missing controller executable with a usage error" {
  run bash "${SCRIPT}" activate "${BATS_TEST_TMPDIR}/nowhere.app"
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"Controller executable does not exist:"* ]]
}
