#!/usr/bin/env bats
#
# Wiring guard for the opt-in live idle-release job (#10840). The job drives a real emulator,
# so it must be dispatch-only: any other trigger would put it on pull requests or merges.

WORKFLOW=".github/workflows/live-idle-release.yml"
RUNNER="scripts/ci/run-live-idle-release.sh"

@test "the live idle-release workflow triggers on workflow_dispatch only" {
  run awk '/^on:/{on=1; next} on && /^[^ #]/{exit} on && /^  [a-z_]+:/{print $1}' "${WORKFLOW}"
  [ "${status}" -eq 0 ]
  [ "${output}" = "workflow_dispatch:" ]
}

@test "every job in the workflow is guarded to workflow_dispatch" {
  jobs="$(awk '/^jobs:/{j=1; next} j && /^  [a-z-]+:/{n++} END{print n}' "${WORKFLOW}")"
  guards="$(grep -c "if: github.event_name == 'workflow_dispatch'" "${WORKFLOW}")"
  [ "${jobs}" -eq "${guards}" ]
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
