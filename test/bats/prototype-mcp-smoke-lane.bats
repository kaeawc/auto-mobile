#!/usr/bin/env bats
# All simulator, build and CLI work is stubbed; no device or daemon is touched.

setup() {
  repo_root="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  script="${repo_root}/scripts/ios/prototype-mcp-smoke-lane.sh"
  stubs="${BATS_TEST_TMPDIR}/stubs"
  mkdir -p "${stubs}" "${BATS_TEST_TMPDIR}/tmp"
  export TMPDIR="${BATS_TEST_TMPDIR}/tmp"
  export STUB_LOG="${BATS_TEST_TMPDIR}/calls.log"
  : > "${STUB_LOG}"
  export XCRUN_BIN="${stubs}/xcrun"
  export XCODEBUILD_BIN="${stubs}/xcodebuild"
  export PROTOTYPE_MCP_SMOKE_SCRIPT="${stubs}/smoke.sh"
  export PROTOTYPE_MCP_SMOKE_LOG_DIR="${BATS_TEST_TMPDIR}/out"
  export PATH="${stubs}:${PATH}"
  unset AUTO_MOBILE_CMD PROTOTYPE_SMOKE_DEVICE_TYPE
  export STUB_BUILD_MODE=ok STUB_SMOKE_EXIT=0 STUB_BOOT_FAIL=0 STUB_CLEANUP_FAIL=0

  cat > "${XCRUN_BIN}" <<'STUB'
#!/usr/bin/env bash
printf 'xcrun %s\n' "$*" >> "${STUB_LOG}"
case "$*" in
  'simctl list runtimes available iOS --json')
    cat <<'JSON'
{"runtimes":[
 {"version":"18.5","identifier":"runtime.18.5","isAvailable":true,"supportedDeviceTypes":[{"identifier":"dt.old","productFamily":"iPhone"}]},
 {"version":"26.5","identifier":"runtime.26.5","isAvailable":true,"supportedDeviceTypes":[{"identifier":"dt.first","productFamily":"iPhone"},{"identifier":"dt.newest","productFamily":"iPhone"},{"identifier":"dt.tablet","productFamily":"iPad"}]},
 {"version":"26.4","identifier":"runtime.26.4","isAvailable":true,"supportedDeviceTypes":[]},
 {"version":"27.0","identifier":"runtime.27","isAvailable":false,"supportedDeviceTypes":[]}
]}
JSON
    ;;
  'simctl create prototype-mcp-smoke-'*) echo UDID-FRESH ;;
  'simctl boot UDID-FRESH') ;;
  'simctl bootstatus UDID-FRESH -b') exit "${STUB_BOOT_FAIL}" ;;
  'simctl shutdown UDID-FRESH'|'simctl delete UDID-FRESH') exit "${STUB_CLEANUP_FAIL}" ;;
  *) exit 99 ;;
esac
STUB
  cat > "${XCODEBUILD_BIN}" <<'STUB'
#!/usr/bin/env bash
printf 'build %s\n' "$*" >> "${STUB_LOG}"
[[ "${STUB_BUILD_MODE}" != fail ]] || exit 65
[[ "$1" == -project && "$2" == */ios/Playground/Playground.xcodeproj ]] || exit 99
shift 2
[[ "$1 $2 $3 $4 $5 $6 $7" == '-scheme Playground -configuration Debug -destination platform=iOS Simulator,id=UDID-FRESH -derivedDataPath' ]] || exit 99
[[ "$9" == build ]] || exit 99
printf '%s\n' "$8" > "${BATS_TEST_TMPDIR}/derived-path"
if [[ "${STUB_BUILD_MODE}" != missing-app ]]; then
  mkdir -p "$8/Build/Products/Debug-iphonesimulator/Playground.app"
fi
STUB
  cat > "${PROTOTYPE_MCP_SMOKE_SCRIPT}" <<'STUB'
#!/usr/bin/env bash
printf 'smoke %s\ncmd %s\napp %s\ncwd %s\n' "$*" "${AUTO_MOBILE_CMD}" "${PROTOTYPE_SMOKE_APP_BUNDLE}" "$PWD" >> "${STUB_LOG}"
[[ "$*" == UDID-FRESH && -d "${PROTOTYPE_SMOKE_APP_BUNDLE}" ]] || exit 99
read -r -a cli <<< "${AUTO_MOBILE_CMD}"
"${cli[@]}" || exit 99
exit "${STUB_SMOKE_EXIT}"
STUB
  cat > "${stubs}/bun" <<'STUB'
#!/usr/bin/env bash
printf 'bun %s\n' "$*" >> "${STUB_LOG}"
STUB
  chmod +x "${XCRUN_BIN}" "${XCODEBUILD_BIN}" "${stubs}/bun"
}

assert_cleaned() {
  grep -qx 'xcrun simctl shutdown UDID-FRESH' "${STUB_LOG}"
  grep -qx 'xcrun simctl delete UDID-FRESH' "${STUB_LOG}"
  [ "$(grep -c '^xcrun simctl delete ' "${STUB_LOG}")" -eq 1 ]
  if [[ -f "${BATS_TEST_TMPDIR}/derived-path" ]]; then
    [ ! -e "$(cat "${BATS_TEST_TMPDIR}/derived-path")" ]
  fi
}

@test "missing or unavailable runtime skips without creating a simulator" {
  run bash "${script}" 27
  [ "${status}" -eq 3 ]
  [[ "${output}" == *"no installed iOS runtime matches '27'; skipping"* ]]
  ! grep -q 'simctl create' "${STUB_LOG}"
  ! grep -q '^build ' "${STUB_LOG}"
}

@test "success selects the newest matching runtime and creates boots and deletes once" {
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  grep -q '^xcrun simctl create prototype-mcp-smoke-26.5-.* dt.newest runtime.26.5$' "${STUB_LOG}"
  [ "$(grep -c '^xcrun simctl create ' "${STUB_LOG}")" -eq 1 ]
  grep -qx 'xcrun simctl boot UDID-FRESH' "${STUB_LOG}"
  grep -qx 'xcrun simctl bootstatus UDID-FRESH -b' "${STUB_LOG}"
  [[ "$(cat "${STUB_LOG}")" == *'simctl boot UDID-FRESH'*'simctl bootstatus UDID-FRESH -b'*'build '*'smoke UDID-FRESH'*'simctl shutdown UDID-FRESH'*'simctl delete UDID-FRESH'* ]]
  [ -f "${PROTOTYPE_MCP_SMOKE_LOG_DIR}/smoke.log" ]
  assert_cleaned
}

@test "Playground build failure exits 1 and still cleans up" {
  export STUB_BUILD_MODE=fail
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ "${output}" == *'Playground build failed'* ]]
  ! grep -q '^smoke ' "${STUB_LOG}"
  assert_cleaned
}

@test "missing built app fails and still cleans up" {
  export STUB_BUILD_MODE=missing-app
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ "${output}" == *'Playground build produced no app'* ]]
  ! grep -q '^smoke ' "${STUB_LOG}"
  assert_cleaned
}

@test "MCP smoke failure propagates its exit code and still cleans up" {
  export STUB_SMOKE_EXIT=42 STUB_CLEANUP_FAIL=1
  run bash "${script}" 26
  [ "${status}" -eq 42 ]
  assert_cleaned
}

@test "default source CLI command and built app reach the MCP smoke from the repo root" {
  run bash "${script}" latest
  [ "${status}" -eq 0 ]
  grep -qx 'cmd bun run src/index.ts --debug --embedded-sdk --cli' "${STUB_LOG}"
  grep -qx 'bun run src/index.ts --debug --embedded-sdk --cli' "${STUB_LOG}"
  grep -Fx "app $(cat "${BATS_TEST_TMPDIR}/derived-path")/Build/Products/Debug-iphonesimulator/Playground.app" "${STUB_LOG}"
  grep -Fx "cwd ${repo_root}" "${STUB_LOG}"
  assert_cleaned
}

@test "CLI command and device type overrides are honored with an exact runtime" {
  export AUTO_MOBILE_CMD="${stubs}/bun custom --cli"
  export PROTOTYPE_SMOKE_DEVICE_TYPE=dt.override
  run bash "${script}" 18.5
  [ "${status}" -eq 0 ]
  grep -q 'dt.override runtime.18.5$' "${STUB_LOG}"
  grep -qx 'bun custom --cli' "${STUB_LOG}"
  assert_cleaned
}

@test "boot failure exits 1 and still cleans up" {
  export STUB_BOOT_FAIL=9
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  ! grep -q '^build ' "${STUB_LOG}"
  assert_cleaned
}

@test "invalid or missing version exits 2 before any tool call" {
  run bash "${script}" '26; invalid'
  [ "${status}" -eq 2 ]
  run bash "${script}"
  [ "${status}" -eq 2 ]
  [ ! -s "${STUB_LOG}" ]
}
