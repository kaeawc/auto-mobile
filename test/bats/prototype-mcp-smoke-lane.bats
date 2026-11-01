#!/usr/bin/env bats
# All simulator, build and CLI work is stubbed; no device or daemon is touched.
# Bats runs each test in its own subshell; exported fixture overrides are intentional.
# shellcheck disable=SC2030,SC2031

setup() {
  bats_require_minimum_version 1.5.0
  repo_root="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  script="${repo_root}/scripts/ios/prototype-mcp-smoke-lane.sh"
  stubs="${BATS_TEST_TMPDIR}/stubs"
  mkdir -p "${stubs}" "${BATS_TEST_TMPDIR}/tmp" "${BATS_TEST_TMPDIR}/aux"
  export TMPDIR="${BATS_TEST_TMPDIR}/tmp"
  export STUB_LOG="${BATS_TEST_TMPDIR}/calls.log"
  : > "${STUB_LOG}"
  export XCRUN_BIN="${stubs}/xcrun"
  export LSOF_BIN="${stubs}/lsof"
  export XCODEBUILD_BIN="${stubs}/xcodebuild"
  export PROTOTYPE_MCP_SMOKE_SCRIPT="${stubs}/smoke.sh"
  export PROTOTYPE_MCP_SMOKE_LOG_DIR="${BATS_TEST_TMPDIR}/out"
  export PROTOTYPE_MCP_SMOKE_AUX_ROOT="${BATS_TEST_TMPDIR}/aux"
  export PROTOTYPE_MCP_SMOKE_RETRY_SLEEP=0
  export PROTOTYPE_MCP_SMOKE_NOW_EPOCH=1800000000
  export PATH="${stubs}:${PATH}"
  unset AUTO_MOBILE_CMD PROTOTYPE_SMOKE_DEVICE_TYPE GITHUB_RUN_ID PROTOTYPE_MCP_SMOKE_DAEMON_PORT
  export STUB_PORT_IN_USE=0 STUB_DAEMON_START_FAIL=0
  export STUB_BUILD_MODE=ok STUB_SMOKE_EXIT=0 STUB_BOOT_FAIL=0 STUB_CLEANUP_FAIL=0
  export STUB_STALE_DEVICES=0 STUB_DELETE_FAIL_TIMES=0 STUB_LIST_FAIL=0 STUB_STALE_DELETE_FAIL=0 STUB_DAEMON_STOP_EXIT=0

  cat > "${LSOF_BIN}" <<'STUB'
#!/usr/bin/env bash
printf 'lsof %s\n' "$*" >> "${STUB_LOG}"
[[ ${STUB_PORT_IN_USE} == 1 ]]
STUB
  cat > "${XCRUN_BIN}" <<'STUB'
#!/usr/bin/env bash
printf 'xcrun %s\n' "$*" >> "${STUB_LOG}"
case "$*" in
  'simctl list runtimes available iOS --json')
    cat <<'JSON'
{"runtimes":[
 {"version":"18.5","identifier":"runtime.18.5","isAvailable":true,"supportedDeviceTypes":[{"identifier":"dt.old","name":"iPhone 15","productFamily":"iPhone"}]},
 {"version":"26.5","identifier":"runtime.26.5","isAvailable":true,"supportedDeviceTypes":[{"identifier":"dt.first","name":"iPhone 16","productFamily":"iPhone"},{"identifier":"dt.newest","name":"iPhone 17 Pro","productFamily":"iPhone"},{"identifier":"dt.old","name":"iPhone 15","productFamily":"iPhone"},{"identifier":"dt.tablet","name":"iPad Pro","productFamily":"iPad"}]},
 {"version":"26.4","identifier":"runtime.26.4","isAvailable":true,"supportedDeviceTypes":[]},
 {"version":"27.0","identifier":"runtime.27","isAvailable":false,"supportedDeviceTypes":[]}
]}
JSON
    ;;
  'simctl list devices --json')
    [[ "${STUB_LIST_FAIL}" -eq 0 ]] || exit 1
    if [[ "${STUB_STALE_DEVICES}" -eq 1 ]]; then
      cat <<'JSON'
{"devices":{"runtime.26.5":[
 {"name":"prototype-mcp-smoke-26.5-run424241-leg26-epoch1799992799-123","udid":"UDID-STALE"},
 {"name":"prototype-mcp-smoke-26.5-run424241-leglatest-epoch1799999999-456","udid":"UDID-RECENT"},
 {"name":"prototype-mcp-smoke-26.5-run424242-leg26-epoch1799999999-789","udid":"UDID-CURRENT"},
 {"name":"prototype-mcp-smoke-26.5-run424241-leg26-epoch1799992800-123","udid":"UDID-BOUNDARY"},
 {"name":"prototype-mcp-smoke-26.5-run424241-leg26-epoch1800000001-123","udid":"UDID-FUTURE"},
 {"name":"prototype-mcp-smoke-26.5-run424241-leg26-epochoops-123","udid":"UDID-MALFORMED"},
 {"name":"prototype-mcp-smoke-26.5-run424241-123","udid":"UDID-LEGACY"},
 {"name":"other-prototype-mcp-smoke-26.5-run424241-leg26-epoch1799992799-123","udid":"UDID-PREFIX"},
 {"name":"AutoMobile CI iPhone","udid":"UDID-CI"}
]}}
JSON
    else
      printf '%s\n' '{"devices":{"runtime.26.5":[{"name":"AutoMobile CI iPhone","udid":"UDID-CI"}]}}'
    fi
    ;;
  'simctl create prototype-mcp-smoke-'*) echo UDID-FRESH ;;
  'simctl boot UDID-FRESH') ;;
  'simctl bootstatus UDID-FRESH -b') exit "${STUB_BOOT_FAIL}" ;;
  'simctl shutdown UDID-FRESH') exit "${STUB_CLEANUP_FAIL}" ;;
  'simctl delete UDID-FRESH')
    counter="${BATS_TEST_TMPDIR}/delete-count"
    count=0
    if [[ -f "${counter}" ]]; then read -r count < "${counter}"; fi
    count=$((count + 1))
    printf '%s\n' "${count}" > "${counter}"
    [[ "${count}" -gt "${STUB_DELETE_FAIL_TIMES}" ]] || exit 1
    exit "${STUB_CLEANUP_FAIL}"
    ;;
  'simctl shutdown UDID-STALE') ;;
  'simctl delete UDID-STALE') exit "${STUB_STALE_DELETE_FAIL}" ;;
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
printf 'smoke aux=%s socket=%s pid=%s session=%s legacy-session=%s\n' "${AUTOMOBILE_AUX_SOCKET_DIR}" "${AUTOMOBILE_DAEMON_SOCKET_PATH-unset}" "${AUTO_MOBILE_DAEMON_PID_FILE_PATH-unset}" "${AUTOMOBILE_SESSION_UUID-unset}" "${AUTO_MOBILE_SESSION_UUID-unset}" >> "${STUB_LOG}"
[[ -d "${AUTOMOBILE_AUX_SOCKET_DIR}" ]] || exit 99
[[ "$*" == UDID-FRESH && -d "${PROTOTYPE_SMOKE_APP_BUNDLE}" ]] || exit 99
read -r -a cli <<< "${AUTO_MOBILE_CMD}"
"${cli[@]}" || exit 99
exit "${STUB_SMOKE_EXIT}"
STUB
  cat > "${stubs}/bun" <<'STUB'
#!/usr/bin/env bash
printf 'bun %s\n' "$*" >> "${STUB_LOG}"
printf 'cli aux=%s socket=%s pid=%s\n' "${AUTOMOBILE_AUX_SOCKET_DIR}" "${AUTOMOBILE_DAEMON_SOCKET_PATH-unset}" "${AUTO_MOBILE_DAEMON_PID_FILE_PATH-unset}" >> "${STUB_LOG}"
[[ -d "${AUTOMOBILE_AUX_SOCKET_DIR}" ]] || exit 99
if [[ " $* " == *' --daemon start '* ]]; then
  printf 'db dir=%s path=%s legacy=%s\n' "${AUTOMOBILE_DB_DIR-unset}" "${AUTOMOBILE_DB_PATH-unset}" "${AUTO_MOBILE_DB_PATH-unset}" >> "${STUB_LOG}"
  [[ ${STUB_DAEMON_START_FAIL} == 0 ]]
  exit $?
fi
for arg in "$@"; do
  case "$arg" in --port | --port=*) exit 99 ;; esac
done
if [[ " $* " == *' --daemon stop '* ]]; then
  printf 'daemon-stop aux=%s\n' "${AUTOMOBILE_AUX_SOCKET_DIR}" >> "${STUB_LOG}"
  exit "${STUB_DAEMON_STOP_EXIT}"
fi
STUB
  chmod +x "${LSOF_BIN}" "${XCRUN_BIN}" "${XCODEBUILD_BIN}" "${stubs}/bun"
}

assert_cleaned() {
  if grep -q 'xcrun .*UDID-CI' "${STUB_LOG}"; then return 1; fi
  grep -qx 'xcrun simctl shutdown UDID-FRESH' "${STUB_LOG}"
  grep -qx 'xcrun simctl delete UDID-FRESH' "${STUB_LOG}"
  [ "$(grep -c '^xcrun simctl delete ' "${STUB_LOG}")" -eq 1 ]
  if [[ -f "${BATS_TEST_TMPDIR}/derived-path" ]]; then
    [ ! -e "$(cat "${BATS_TEST_TMPDIR}/derived-path")" ]
  fi
}

@test "missing or unavailable runtime skips without creating a simulator" {
  run bash "${script}" 27
  [ "${status}" -eq 3 ] || { echo "${output}"; return 1; }
  [[ "${output}" == *"no installed iOS runtime matches '27'; skipping"* ]]
  run ! grep -q 'simctl create' "${STUB_LOG}"
  run ! grep -q '^build ' "${STUB_LOG}"
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
  run ! grep -q '^smoke ' "${STUB_LOG}"
  assert_cleaned
}

@test "missing built app fails and still cleans up" {
  export STUB_BUILD_MODE=missing-app
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ "${output}" == *'Playground build produced no app'* ]]
  run ! grep -q '^smoke ' "${STUB_LOG}"
  assert_cleaned
}

@test "MCP smoke failure propagates its exit code and still cleans up" {
  export STUB_SMOKE_EXIT=42
  run bash "${script}" 26
  [ "${status}" -eq 42 ]
  assert_cleaned
}

@test "private aux directory exists before the first CLI call and is removed afterward" {
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  aux="$(sed -n 's/^smoke aux=\([^ ]*\).*/\1/p' "${STUB_LOG}")"
  [[ "${aux}" == /* && "${aux}" == "${PROTOTYPE_MCP_SMOKE_AUX_ROOT}/apm-aux."* ]]
  [[ "${aux}" != /tmp/auto-mobile-daemon-* ]]
  grep -Fx "cli aux=${aux} socket=unset pid=unset" "${STUB_LOG}"
  [ ! -e "${aux}" ]
  assert_cleaned
}

@test "inherited daemon and session routing variables are scrubbed for smoke and stop" {
  export AUTOMOBILE_DAEMON_SOCKET_PATH="${BATS_TEST_TMPDIR}/resident.sock"
  export AUTO_MOBILE_DAEMON_PID_FILE_PATH="${BATS_TEST_TMPDIR}/resident.pid"
  export AUTOMOBILE_SESSION_UUID=resident-session AUTO_MOBILE_SESSION_UUID=legacy-session
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  grep -q '^smoke aux=.* socket=unset pid=unset session=unset legacy-session=unset$' "${STUB_LOG}"
  run ! grep -q 'resident\|legacy-session=legacy' "${STUB_LOG}"
  [ "$(grep -c '^cli aux=.* socket=unset pid=unset$' "${STUB_LOG}")" -eq 3 ]
  assert_cleaned
}

@test "owned daemon stops exactly once using the smoke aux directory before simulator shutdown" {
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  aux="$(sed -n 's/^smoke aux=\([^ ]*\).*/\1/p' "${STUB_LOG}")"
  [ "$(grep -c '^daemon-stop ' "${STUB_LOG}")" -eq 1 ]
  grep -Fx "daemon-stop aux=${aux}" "${STUB_LOG}"
  grep -qx 'bun run src/index.ts --debug --embedded-sdk --daemon stop' "${STUB_LOG}"
  [[ "$(cat "${STUB_LOG}")" == *"daemon-stop aux=${aux}"*'xcrun simctl shutdown UDID-FRESH'* ]]
  assert_cleaned
}

@test "lane simulators older than two hours are removed before create" {
  export GITHUB_RUN_ID=424242 STUB_STALE_DEVICES=1
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  [[ "$(cat "${STUB_LOG}")" == *'xcrun simctl shutdown UDID-STALE'*'xcrun simctl delete UDID-STALE'*'xcrun simctl create '* ]]
  run ! grep -q 'xcrun .*UDID-CURRENT\|xcrun .*UDID-CI' "${STUB_LOG}"
  [ "$(grep -c '^xcrun simctl delete UDID-STALE$' "${STUB_LOG}")" -eq 1 ]
  [ "$(grep -c '^xcrun simctl delete UDID-FRESH$' "${STUB_LOG}")" -eq 1 ]
}

@test "recent other-run and current-run simulators survive the sweep" {
  export GITHUB_RUN_ID=424242 STUB_STALE_DEVICES=1
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  run ! grep -Eq 'xcrun .*UDID-(RECENT|CURRENT)' "${STUB_LOG}"
}

@test "simulators exactly two hours old or future dated survive the sweep" {
  export STUB_STALE_DEVICES=1
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  run ! grep -Eq 'xcrun .*UDID-(BOUNDARY|FUTURE)' "${STUB_LOG}"
}

@test "unparseable and legacy lane names survive the sweep" {
  export STUB_STALE_DEVICES=1
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  run ! grep -Eq 'xcrun .*UDID-(MALFORMED|LEGACY)' "${STUB_LOG}"
}

@test "AutoMobile CI iPhone and names without the exact lane prefix are never matched" {
  export STUB_STALE_DEVICES=1
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  run ! grep -Eq 'xcrun .*UDID-(CI|PREFIX)' "${STUB_LOG}"
}

@test "delete retries twice then succeeds without failing the lane" {
  export STUB_DELETE_FAIL_TIMES=2
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  [ "$(grep -c '^xcrun simctl delete UDID-FRESH$' "${STUB_LOG}")" -eq 3 ]
}

@test "delete exhaustion fails an otherwise passing smoke" {
  export STUB_CLEANUP_FAIL=1
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ "${output}" == *'prototype-mcp-smoke-lane: FAIL: could not delete simulator UDID-FRESH'* ]]
  [ "$(grep -c '^xcrun simctl delete UDID-FRESH$' "${STUB_LOG}")" -eq 3 ]
}

@test "delete exhaustion preserves an existing smoke failure" {
  export STUB_SMOKE_EXIT=42 STUB_CLEANUP_FAIL=1
  run bash "${script}" 26
  [ "${status}" -eq 42 ]
  [ "$(grep -c '^xcrun simctl delete UDID-FRESH$' "${STUB_LOG}")" -eq 3 ]
}

@test "simulator name contains the GitHub run tag matrix leg and creation epoch" {
  export GITHUB_RUN_ID=424242
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  grep -Eq '^xcrun simctl create prototype-mcp-smoke-26.5-run424242-leg26-epoch1800000000-[0-9]+ dt.newest runtime.26.5$' "${STUB_LOG}"
  assert_cleaned
}

@test "device selection uses model generation even when older iPhones appear later" {
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  grep -q '^xcrun simctl create .* dt.newest runtime.26.5$' "${STUB_LOG}"
  assert_cleaned
}

@test "stale listing failure warns and continues" {
  export STUB_LIST_FAIL=1
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'warning: could not list stale simulators'* ]]
  assert_cleaned
}

@test "stale delete exhaustion warns and continues" {
  export GITHUB_RUN_ID=424242 STUB_STALE_DEVICES=1 STUB_STALE_DELETE_FAIL=1
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'warning: could not delete stale simulator UDID-STALE'* ]]
  [ "$(grep -c '^xcrun simctl delete UDID-STALE$' "${STUB_LOG}")" -eq 3 ]
  run ! grep -q 'xcrun .*UDID-CURRENT\|xcrun .*UDID-CI' "${STUB_LOG}"
}

@test "daemon stop failure does not fail the lane or skip cleanup" {
  export STUB_DAEMON_STOP_EXIT=1
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'prototype-mcp-smoke-lane: daemon stop failed for '* ]]
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
  run ! grep -q '^build ' "${STUB_LOG}"
  assert_cleaned
}

@test "invalid or missing version exits 2 before any tool call" {
  run bash "${script}" '26; invalid'
  [ "${status}" -eq 2 ]
  run bash "${script}"
  [ "${status}" -eq 2 ]
  [ ! -s "${STUB_LOG}" ]
}

@test "refuses port 3000 before any xcrun call" {
  export PROTOTYPE_MCP_SMOKE_DAEMON_PORT=3000
  run bash "${script}" 26
  [ "${status}" -eq 2 ] || { echo "${output}"; return 1; }
  [[ "${output}" == *'never 3000'* ]]
  run ! grep -q '^xcrun ' "${STUB_LOG}"
}

@test "refuses nonnumeric and out-of-range ports before any xcrun call" {
  for port in nope 39999 65536; do
    export PROTOTYPE_MCP_SMOKE_DAEMON_PORT="${port}"
    run bash "${script}" 26
    [ "${status}" -eq 2 ]
    run ! grep -q '^xcrun ' "${STUB_LOG}"
  done
}

@test "refuses a listening port before simulator creation or daemon start" {
  export PROTOTYPE_MCP_SMOKE_DAEMON_PORT=45678 STUB_PORT_IN_USE=1
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ "${output}" == *'port 45678 is already listening'* ]]
  grep -qx 'lsof -nP -iTCP:45678 -sTCP:LISTEN' "${STUB_LOG}"
  run ! grep -Eq 'simctl create|--daemon start' "${STUB_LOG}"
}

@test "requires lsof before any xcrun call" {
  export LSOF_BIN="${stubs}/missing-lsof"
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ "${output}" == *'lsof is required'* ]]
  run ! grep -q '^xcrun ' "${STUB_LOG}"
}

@test "default private daemon starts after build before smoke with port only on start" {
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  calls="$(cat "${STUB_LOG}")"
  start="$(grep '^bun .*--daemon start' "${STUB_LOG}")"
  [[ "${start}" =~ ^bun\ run\ src/index.ts\ --debug\ --embedded-sdk\ --daemon\ start\ --debug\ --embedded-sdk\ --port\ ([0-9]+)$ ]]
  port="${BASH_REMATCH[1]}"
  (( port >= 40000 && port <= 65535 && port != 3000 ))
  [[ "${calls}" == *'build '*"${start}"*'smoke UDID-FRESH'* ]]
  [ "$(grep -c -- '--port' "${STUB_LOG}")" -eq 1 ]
  assert_cleaned
}

@test "default command repeats only startup options after daemon start" {
  export PROTOTYPE_MCP_SMOKE_DAEMON_PORT=45678
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  start="$(grep '^bun .*--daemon start' "${STUB_LOG}")"
  [ "${start}" = 'bun run src/index.ts --debug --embedded-sdk --daemon start --debug --embedded-sdk --port 45678' ]
  assert_cleaned
}

@test "silent runtime command repeats only startup options after daemon start" {
  export AUTO_MOBILE_CMD="${stubs}/bun run --silent src/index.ts --debug --embedded-sdk --cli"
  export PROTOTYPE_MCP_SMOKE_DAEMON_PORT=45678
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  start="$(grep '^bun .*--daemon start' "${STUB_LOG}")"
  [ "${start}" = 'bun run --silent src/index.ts --debug --embedded-sdk --daemon start --debug --embedded-sdk --port 45678' ]
  [ "$(printf '%s\n' "${start}" | grep -o -- '--silent' | wc -l)" -eq 1 ]
  assert_cleaned
}

@test "failed explicit daemon start stops once and deletes simulator" {
  export STUB_DAEMON_START_FAIL=1
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ "${output}" == *'private daemon start failed'* ]]
  [ "$(grep -c -- '--daemon stop' "${STUB_LOG}")" -eq 1 ]
  run ! grep -q '^smoke ' "${STUB_LOG}"
  assert_cleaned
}

@test "private daemon database overrides inherited exact paths and clears legacy alias" {
  export AUTOMOBILE_DB_DIR="${BATS_TEST_TMPDIR}/resident"
  export AUTOMOBILE_DB_PATH="${BATS_TEST_TMPDIR}/resident.db"
  export AUTO_MOBILE_DB_PATH="${BATS_TEST_TMPDIR}/legacy-resident.db"
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  aux="$(sed -n 's/^daemon-stop aux=//p' "${STUB_LOG}")"
  [ -n "${aux}" ]
  grep -Fxq "db dir=${aux}/db path=${aux}/db/auto-mobile.db legacy=unset" "${STUB_LOG}"
}
