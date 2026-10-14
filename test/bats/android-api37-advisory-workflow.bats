#!/usr/bin/env bats
# Wiring guard for the opt-in API 37 advisory emulator workflow (#12273).

WORKFLOW=".github/workflows/android-api37-emulator-tests.yml"

@test "top-level triggers are pull_request, schedule, workflow_dispatch in order" {
  run awk '/^on:/{on=1; next} on && /^[^ #]/{exit} on && /^  [a-z_]+:/{print $1}' "${WORKFLOW}"
  [ "${status}" -eq 0 ]
  [ "${output}" = $'pull_request:\nschedule:\nworkflow_dispatch:' ]
}

@test "pull requests trigger only for labeled and synchronize events" {
  run awk '/^  pull_request:/{pr=1; next} pr && /^  [a-z_]+:/{exit} pr && /types:/{print; exit}' "${WORKFLOW}"
  [ "${status}" -eq 0 ]
  [ "${output}" = "    types: [labeled, synchronize]" ]
}

@test "the single job is advisory and clearly named" {
  grep -qF 'name: "Run Android Emulator Tests (API 37, Advisory)"' "${WORKFLOW}"
  grep -q '^    continue-on-error: true$' "${WORKFLOW}"
}

@test "the pull request guard requires the run-api37 label" {
  grep -q "contains(github.event.pull_request.labels.\*.name, 'run-api37')" "${WORKFLOW}"
}

@test "API 37 is passed to the shared action and the combined suite script runs" {
  grep -q '^          api_level: "37"$' "${WORKFLOW}"
  grep -q 'uses: ./.github/actions/android-emulator' "${WORKFLOW}"
  grep -qF 'scripts/android/run-emulator-suites.sh control-proxy/build/outputs/apk/debug/control-proxy-debug.apk' "${WORKFLOW}"
}

@test "no other workflow references or depends on this advisory workflow" {
  if grep -lE 'android-api37-emulator-tests|Android API 37 Emulator Tests|run-api37' .github/workflows/* | grep -v '^.github/workflows/android-api37-emulator-tests.yml$'; then
    return 1
  fi
}

@test "artifact names and report check names are unique across workflows" {
  names='junit-runner-api37-heap-dumps-emulator|junit-runner-api37-emulator-test-results|playground-api37-emulator-test-results|JUnit Runner API 37 Emulator Test Report \(Advisory\)|Playground API 37 Emulator Test Report \(Advisory\)'
  if grep -lE "${names}" .github/workflows/* | grep -v '^.github/workflows/android-api37-emulator-tests.yml$'; then
    return 1
  fi
  [ "$(grep -Ec 'name: (junit-runner-api37-heap-dumps-emulator|junit-runner-api37-emulator-test-results|playground-api37-emulator-test-results|"JUnit Runner API 37 Emulator Test Report \(Advisory\)"|"Playground API 37 Emulator Test Report \(Advisory\)")' "${WORKFLOW}")" -eq 5 ]
}

@test "workflow has no pull_request_target trigger or needs dependency" {
  ! grep -q 'pull_request_target' "${WORKFLOW}"
  ! grep -q '^    needs:' "${WORKFLOW}"
}
