#!/usr/bin/env bats
#
# Release guard and committed MDM profile for the network filter (#10595).

EXT_ID="dev.jasonpearson.automobile.networkfilter.provider"
APP_ID="dev.jasonpearson.automobile.networkfilter"
EXT_DR='anchor apple generic and identifier "dev.jasonpearson.automobile.networkfilter.provider" and certificate leaf[subject.OU] = "CEZH89E7MT"'
APP_DR='anchor apple generic and identifier "dev.jasonpearson.automobile.networkfilter" and certificate leaf[subject.OU] = "CEZH89E7MT"'

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/ci/verify-network-filter-requirement.sh"
  PROFILE="${REPO_ROOT}/docs/assets/mdm/automobile-network-filter.mobileconfig"
  STUBS="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${STUBS}"
  export CODESIGN_LOG="${BATS_TEST_TMPDIR}/codesign.log"
  # codesign stub: records each call; fails a -R= requirement listed in
  # CODESIGN_REJECT, mimicking codesign's exit 3 on a requirement mismatch.
  cat > "${STUBS}/codesign" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CODESIGN_LOG}"
for arg in "$@"; do
  if [[ "${arg}" == -R=* && -n "${CODESIGN_REJECT:-}" && "${arg#-R=}" == "${CODESIGN_REJECT}" ]]; then
    echo "test-requirement: code failed to satisfy specified code requirement(s)" >&2
    exit 3
  fi
done
exit 0
STUB
  # plutil stub: answers `-extract PayloadContent.1.<key> raw` from the
  # committed profile's values so the test runs off macOS too.
  cat > "${STUBS}/plutil" <<'STUB'
#!/usr/bin/env bash
case "$2" in
  PayloadContent.1.PayloadType) echo "${STUB_PAYLOAD_TYPE:-com.apple.webcontent-filter}" ;;
  PayloadContent.1.FilterDataProviderBundleIdentifier) echo "dev.jasonpearson.automobile.networkfilter.provider" ;;
  PayloadContent.1.PluginBundleID) echo "dev.jasonpearson.automobile.networkfilter" ;;
  PayloadContent.1.FilterDataProviderDesignatedRequirement)
    echo 'anchor apple generic and identifier "dev.jasonpearson.automobile.networkfilter.provider" and certificate leaf[subject.OU] = "CEZH89E7MT"' ;;
  *) echo "unexpected keypath $2" >&2; exit 1 ;;
esac
STUB
  chmod +x "${STUBS}/codesign" "${STUBS}/plutil"
  export CODESIGN="${STUBS}/codesign"
  export PLUTIL="${STUBS}/plutil"
  APP="${BATS_TEST_TMPDIR}/AutoMobile Network Identity Probe.app"
  EXT="${APP}/Contents/Library/SystemExtensions/${EXT_ID}.systemextension"
  mkdir -p "${EXT}"
}

@test "verifies the extension and the app against the profile requirement" {
  run bash "${SCRIPT}" "${APP}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"matches the committed MDM profile requirement"* ]]
  run cat "${CODESIGN_LOG}"
  [ "${lines[0]}" = "--verify --deep --strict --verbose=2 -R=${EXT_DR} ${EXT}" ]
  [ "${lines[1]}" = "--verify --deep --strict --verbose=2 -R=${APP_DR} ${APP}" ]
}

@test "fails when the extension signature does not match the profile requirement" {
  export CODESIGN_REJECT="${EXT_DR}"
  run bash "${SCRIPT}" "${APP}"
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"does not satisfy the MDM profile requirement"* ]]
}

@test "fails when the containing app signature does not match" {
  export CODESIGN_REJECT="${APP_DR}"
  run bash "${SCRIPT}" "${APP}"
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"${APP_DR}"* ]]
}

@test "fails when the app has no nested system extension" {
  rm -rf "${APP}/Contents/Library"
  run bash "${SCRIPT}" "${APP}"
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"does not contain the system extension"* ]]
  [ ! -e "${CODESIGN_LOG}" ]
}

@test "refuses a profile whose second payload is not the content filter" {
  export STUB_PAYLOAD_TYPE="com.apple.system-extension-policy"
  run bash "${SCRIPT}" "${APP}"
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"com.apple.webcontent-filter"* ]]
  [ ! -e "${CODESIGN_LOG}" ]
}

@test "usage errors for a missing app path" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 2 ]
  run bash "${SCRIPT}" "${BATS_TEST_TMPDIR}/missing.app"
  [ "${status}" -eq 2 ]
}

@test "reads the real committed profile with plutil (macOS)" {
  if ! command -v /usr/bin/plutil >/dev/null 2>&1; then
    skip "plutil is macOS-only"
  fi
  export PLUTIL=/usr/bin/plutil
  run bash "${SCRIPT}" "${APP}"
  [ "${status}" -eq 0 ]
  run cat "${CODESIGN_LOG}"
  [ "${lines[0]}" = "--verify --deep --strict --verbose=2 -R=${EXT_DR} ${EXT}" ]
  [ "${lines[1]}" = "--verify --deep --strict --verbose=2 -R=${APP_DR} ${APP}" ]
}

@test "committed profile passes plutil -lint (macOS)" {
  if ! command -v /usr/bin/plutil >/dev/null 2>&1; then
    skip "plutil is macOS-only"
  fi
  run /usr/bin/plutil -lint "${PROFILE}"
  [ "${status}" -eq 0 ]
}

@test "committed profile pins the stable requirement and nothing release-specific" {
  grep -Fq "<string>${EXT_DR}</string>" "${PROFILE}"
  grep -Fq "<string>${APP_ID}</string>" "${PROFILE}"
  ! grep -Eiq 'cdhash|CFBundleVersion|CFBundleShortVersionString' "${PROFILE}"
}

@test "the network-filter release build runs the requirement guard on the signed app" {
  local workflow="${REPO_ROOT}/.github/workflows/build-network-filter-probe.yml"
  grep -Fq "./scripts/ci/verify-network-filter-requirement.sh" "${workflow}"
  # The guard must run after signing and before the archive is staged.
  local sign guard stage
  sign="$(grep -n 'name: "Build, sign, and notarize Network Filter identity probe"' "${workflow}" | cut -d: -f1)"
  guard="$(grep -n 'verify-network-filter-requirement.sh' "${workflow}" | head -1 | cut -d: -f1)"
  stage="$(grep -n 'name: "Stage notarized probe archive"' "${workflow}" | cut -d: -f1)"
  [ -n "${sign}" ] && [ -n "${guard}" ] && [ -n "${stage}" ]
  [ "${sign}" -lt "${guard}" ]
  [ "${guard}" -lt "${stage}" ]
}
