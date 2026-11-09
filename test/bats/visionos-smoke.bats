#!/usr/bin/env bats

# Stub-driven checks for scripts/visionos/smoke-visionos-simulator.sh. No simulator
# is touched: xcrun, codesign and sleep are replaced on PATH, and each xcrun call
# is recorded so the test can assert which device the script acted on.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/visionos/smoke-visionos-simulator.sh"
  STUB_BIN="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${STUB_BIN}"
  export STUB_LOG="${BATS_TEST_TMPDIR}/calls.log"
  export STUB_CREATED_UDID="11111111-2222-3333-4444-555555555555"
  export STUB_RUNTIMES_JSON="${BATS_TEST_TMPDIR}/runtimes.json"
  printf '%s' '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.xrOS-26-5","version":"26.5","isAvailable":true},{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","version":"26.5","isAvailable":true}]}' > "${STUB_RUNTIMES_JSON}"
  export STUB_BOOTSTATUS_RC=0
  export OUT_DIR="${BATS_TEST_TMPDIR}/out"

  cat > "${STUB_BIN}/xcrun" <<'STUB'
#!/usr/bin/env bash
echo "xcrun $*" >> "${STUB_LOG}"
if [[ "${1:-}" == "--sdk" ]]; then
  shift 2
  # swiftc: honour -o so the script's binary path exists.
  out=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-o" ]]; then out="$2"; shift; fi
    shift
  done
  [[ -n "$out" ]] && : > "$out"
  exit 0
fi
case "${1:-} ${2:-}" in
  "simctl create") echo "${STUB_CREATED_UDID}" ;;
  "simctl list")   cat "${STUB_RUNTIMES_JSON}" ;;
  "simctl bootstatus") exit "${STUB_BOOTSTATUS_RC}" ;;
  "simctl listapps") echo "dev.jasonpearson.automobile.VisionSmokeFixture" ;;
  "simctl io")
    # screenshot target is the argument after "screenshot"
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "screenshot" ]]; then printf 'PNG' > "$2"; break; fi
      shift
    done ;;
esac
exit 0
STUB
  cat > "${STUB_BIN}/codesign" <<'STUB'
#!/usr/bin/env bash
echo "codesign $*" >> "${STUB_LOG}"
exit 0
STUB
  cat > "${STUB_BIN}/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "${STUB_BIN}/xcrun" "${STUB_BIN}/codesign" "${STUB_BIN}/sleep"
  export PATH="${STUB_BIN}:${PATH}"
}

@test "fails before creating a device when no visionOS runtime is installed" {
  printf '%s' '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","version":"26.5","isAvailable":true}]}' > "${STUB_RUNTIMES_JSON}"
  run bash "${SCRIPT}" "${OUT_DIR}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"no available visionOS runtime"* ]]
  ! grep -q "simctl create" "${STUB_LOG}"
}

@test "happy path boots, installs, launches and screenshots its own device" {
  run bash "${SCRIPT}" "${OUT_DIR}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS: screenshot at"* ]]
  [ -s "${OUT_DIR}/screenshot.png" ]
  grep -q "simctl create .*Apple-Vision-Pro-4K com.apple.CoreSimulator.SimRuntime.xrOS-26-5" "${STUB_LOG}"
  grep -q "simctl install ${STUB_CREATED_UDID}" "${STUB_LOG}"
  grep -q "simctl launch ${STUB_CREATED_UDID} dev.jasonpearson.automobile.VisionSmokeFixture" "${STUB_LOG}"
}

@test "deletes its own device on success" {
  run bash "${SCRIPT}" "${OUT_DIR}"
  [ "${status}" -eq 0 ]
  grep -q "simctl shutdown ${STUB_CREATED_UDID}" "${STUB_LOG}"
  grep -q "simctl delete ${STUB_CREATED_UDID}" "${STUB_LOG}"
}

@test "deletes its own device when boot never finishes" {
  export STUB_BOOTSTATUS_RC=1
  run bash "${SCRIPT}" "${OUT_DIR}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"boot did not finish"* ]]
  grep -q "simctl delete ${STUB_CREATED_UDID}" "${STUB_LOG}"
  ! grep -q "simctl install" "${STUB_LOG}"
}

@test "only ever addresses the device it created" {
  run bash "${SCRIPT}" "${OUT_DIR}"
  [ "${status}" -eq 0 ]
  # Every simctl call that names a UDID must name the one the script created.
  # The protected CI simulator and other lanes' devices must never appear here.
  run bash -c "grep -E 'simctl (boot|bootstatus|install|launch|io|terminate|uninstall|shutdown|delete) ' '${STUB_LOG}' | grep -v '${STUB_CREATED_UDID}' || true"
  [ -z "${output}" ]
  ! grep -q "18A2D9B1-CDFA-445A-93AA-A532EA4B5498" "${STUB_LOG}"
}

@test "never issues Simulator.app or pattern-based kill commands" {
  run bash "${SCRIPT}" "${OUT_DIR}"
  [ "${status}" -eq 0 ]
  ! grep -qE "Simulator\.app|open -a|pkill|killall" "${SCRIPT}"
}
