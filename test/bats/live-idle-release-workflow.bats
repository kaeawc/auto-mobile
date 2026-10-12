#!/usr/bin/env bats
#
# Wiring guard for the live idle-release job (#10840, #10983). The job drives a real emulator, so
# it runs on dispatch and nightly only: any other trigger would put it on pull requests or merges.
# It is advisory only by not being a required check; it must report its own failure (#11368).

WORKFLOW=".github/workflows/live-idle-release.yml"
RUNNER="scripts/ci/run-live-idle-release.sh"

setup() {
  export IDLE_EVIDENCE_DIR="${BATS_TEST_TMPDIR}/evidence"
  export AUTOMOBILE_CTRL_PROXY_APK_PATH="${BATS_TEST_TMPDIR}/fake.apk"
  export IDLE_CHECK_SCRIPT="${BATS_TEST_TMPDIR}/check.sh"
  export CHECK_CALLS="${BATS_TEST_TMPDIR}/check.calls"
  mkdir -p "${IDLE_EVIDENCE_DIR}"
  : > "${AUTOMOBILE_CTRL_PROXY_APK_PATH}"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "${CHECK_CALLS}"\n' > "${IDLE_CHECK_SCRIPT}"
}

@test "the live idle-release workflow triggers on schedule and workflow_dispatch only" {
  run awk '/^on:/{on=1; next} on && /^[^ #]/{exit} on && /^  [a-z_]+:/{print $1}' "${WORKFLOW}"
  [ "${status}" -eq 0 ]
  [ "${output}" = $'schedule:\nworkflow_dispatch:' ]
}

@test "the nightly schedule is a single cron entry" {
  run grep -c '^    - cron: ' "${WORKFLOW}"
  [ "${output}" = "1" ]
}

@test "every job in the workflow is guarded to dispatch or the upstream repository's schedule" {
  jobs="$(awk '/^jobs:/{j=1; next} j && /^  [a-z-]+:/{n++} END{print n}' "${WORKFLOW}")"
  guards="$(grep -c "if: github.event_name == 'workflow_dispatch' || (github.event_name == 'schedule' && github.repository == 'kaeawc/auto-mobile')" "${WORKFLOW}")"
  [ "${jobs}" -eq "${guards}" ]
}

@test "the check job reports its own failure (no continue-on-error) and scheduled runs fall back to the dispatch defaults" {
  run grep -c 'continue-on-error:' "${WORKFLOW}"
  [ "${status}" -eq 1 ]
  [ "${output}" = "0" ]
  grep -qF "inputs.scenario || 'all'" "${WORKFLOW}"
  grep -qF "inputs.idle-timeout-ms || '20000'" "${WORKFLOW}"
}

@test "the job boots the emulator through the shared action and runs the runner script" {
  grep -q "uses: ./.github/actions/android-emulator" "${WORKFLOW}"
  grep -q "bash scripts/ci/run-live-idle-release.sh" "${WORKFLOW}"
  grep -q "name: live-idle-release-evidence" "${WORKFLOW}"
}

@test "pull_request.yml does not reference the live idle-release job" {
  run grep -c "live-idle-release" .github/workflows/pull_request.yml
  [ "${output}" = "0" ]
}

@test "the runner rejects an unsupported scenario and a non-numeric window before touching anything" {
  IDLE_SCENARIO=two-devices run bash "${RUNNER}"
  [ "${status}" -eq 2 ]
  IDLE_TIMEOUT_MS='20000; echo injected' run bash "${RUNNER}"
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"must be an integer"* ]]
}

@test "the runner hands the private daemon an absolute CtrlProxy APK path" {
  repo="$(pwd)"
  stub="${BATS_TEST_TMPDIR}/check.sh"
  printf '#!/usr/bin/env bash\necho "APK=${AUTOMOBILE_CTRL_PROXY_APK_PATH}"\n' > "${stub}"
  rel="control-proxy/build/outputs/apk/debug/control-proxy-debug.apk"
  mkdir -p "${repo}/android/$(dirname "${rel}")"
  created=false
  if [[ ! -e "${repo}/android/${rel}" ]]; then
    : > "${repo}/android/${rel}"
    created=true
  fi
  AUTOMOBILE_CTRL_PROXY_APK_PATH="${rel}" IDLE_CHECK_SCRIPT="${stub}" run bash "${RUNNER}"
  [[ "${created}" == true ]] && rm -f "${repo}/android/${rel}"
  [ "${status}" -eq 0 ]
  [ "${output}" = "APK=${repo}/android/${rel}" ]
}

@test "the runner fails fast when the CtrlProxy APK is missing" {
  AUTOMOBILE_CTRL_PROXY_APK_PATH="${BATS_TEST_TMPDIR}/nope.apk" run bash "${RUNNER}"
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"APK not found"* ]]
}


@test "the runner accepts exactly the workflow scenario options, including observe-only" {
  # Use the installed YAML parser; no shell parsing of YAML structure.
  options="$(bun -e 'import { load } from "js-yaml"; const wf = load(await Bun.file(process.argv[1]).text()); console.log(wf.on.workflow_dispatch.inputs.scenario.options.join("\n"));' "${WORKFLOW}")"
  accepted="$(awk '/^case /{c=1; next} c && /;;/{gsub(/ \| /, "\n"); sub(/^  /, ""); sub(/\) ;;.*/, ""); print; exit}' "${RUNNER}")"
  [ "${accepted}" = "${options}" ]
  while IFS= read -r scenario; do
    IDLE_SCENARIO="${scenario}" run bash "${RUNNER}"
    [ "${status}" -eq 0 ]
    [[ "$(tail -n 1 "${CHECK_CALLS}")" == *"--scenario ${scenario}"* ]]
  done <<< "${options}"
  IDLE_SCENARIO=two-devices run bash "${RUNNER}"
  [ "${status}" -eq 2 ]
  IDLE_SCENARIO=unknown run bash "${RUNNER}"
  [ "${status}" -eq 2 ]
}

@test "sticky verdict rejects an earlier failure without touching its evidence or running the check" {
  printf 'idle\nstream\n' > "${IDLE_EVIDENCE_DIR}/failed-scenarios.txt"
  cp "${IDLE_EVIDENCE_DIR}/failed-scenarios.txt" "${BATS_TEST_TMPDIR}/before"
  # The sticky verdict must precede even APK validation.
  AUTOMOBILE_CTRL_PROXY_APK_PATH="${BATS_TEST_TMPDIR}/missing.apk" run bash "${RUNNER}"
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"idle, stream"*"earlier attempt in this job"*"scenario failure is a verdict and is not retried (#11368)"*"removing"* ]]
  [ ! -e "${CHECK_CALLS}" ]
  cmp "${BATS_TEST_TMPDIR}/before" "${IDLE_EVIDENCE_DIR}/failed-scenarios.txt"
  ! printf '%s\n' "${output}" | grep -iE 'Connection refused|Connection reset|device offline|device not found|adb server|cannot connect to daemon|waiting for device|Forbidden|status code 403|ETIMEDOUT|ECONNRESET|Could not resolve|AdbHostServer|emulator: ERROR|503 Service Unavailable|502 Bad Gateway|SocketTimeoutException|ConnectTimeoutException|connection timed out'
}

@test "the runner invokes the check with no failed verdict or an empty file" {
  run bash "${RUNNER}"
  [ "${status}" -eq 0 ]
  [[ "$(cat "${CHECK_CALLS}")" == *"--evidence-dir ${IDLE_EVIDENCE_DIR}" ]]
  : > "${IDLE_EVIDENCE_DIR}/failed-scenarios.txt"
  run bash "${RUNNER}"
  [ "${status}" -eq 0 ]
  [ "$(wc -l < "${CHECK_CALLS}" | tr -d ' ')" = 2 ]
}

@test "a failed first check cannot be masked by a second invocation that would pass" {
  cat > "${IDLE_CHECK_SCRIPT}" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CHECK_CALLS}"
if [[ ! -e "${IDLE_EVIDENCE_DIR}/failed-scenarios.txt" ]]; then
  printf 'idle\n' > "${IDLE_EVIDENCE_DIR}/failed-scenarios.txt"
  exit 1
fi
exit 0
EOF
  run bash "${RUNNER}"
  [ "${status}" -eq 1 ]
  run bash "${RUNNER}"
  [ "${status}" -eq 1 ]
  [ "$(wc -l < "${CHECK_CALLS}" | tr -d ' ')" = 1 ]
  [ "$(cat "${IDLE_EVIDENCE_DIR}/failed-scenarios.txt")" = idle ]
}
