#!/usr/bin/env bats
# Wiring guard for the advisory Xcode 27 iOS build on the self-hosted Macs (#15244 decision 7).

WORKFLOW=".github/workflows/ios-xcode27-advisory.yml"

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
  grep -qF 'name: "iOS Build (Xcode 27, Advisory)"' "${WORKFLOW}"
  grep -q '^    continue-on-error: true$' "${WORKFLOW}"
  [ "$(grep -c '^  [a-z0-9-]*:$' <(awk '/^jobs:/{j=1; next} j' "${WORKFLOW}"))" -eq 1 ]
}

@test "the job runs on the self-hosted Macs and only when the pool is enabled" {
  grep -qF 'runs-on: ["self-hosted", "automobile-mac"]' "${WORKFLOW}"
  grep -qF "vars.AUTOMOBILE_MAC_POOLS_ENABLED == 'true'" "${WORKFLOW}"
}

@test "pull request guard requires the run-xcode27 label and a same-repo head" {
  grep -qF "contains(github.event.pull_request.labels.*.name, 'run-xcode27')" "${WORKFLOW}"
  grep -qF 'github.event.pull_request.head.repo.full_name == github.repository' "${WORKFLOW}"
  grep -qF "github.event.label.name == 'run-xcode27'" "${WORKFLOW}"
  grep -qF "github.repository == 'kaeawc/auto-mobile'" "${WORKFLOW}"
}

@test "Xcode 27 is selected without touching the machine-wide default" {
  grep -qF 'bash scripts/ci/select-self-hosted-xcode.sh "27.0"' "${WORKFLOW}"
  run grep -nE 'sudo|xcode-select|maxim-lobanov/setup-xcode' "${WORKFLOW}"
  [ "${status}" -eq 1 ]
}

@test "it builds the root package and the prototype library" {
  grep -qF 'swift build -c release' "${WORKFLOW}"
  grep -qF 'bash scripts/ios/prototype-library-build.sh' "${WORKFLOW}"
}

@test "the isolated home is removed in an always step" {
  awk '/Remove isolated Xcode 27 home/{f=1} f && /if: always\(\)/{ok=1} END{exit ok?0:1}' "${WORKFLOW}"
}

@test "no other workflow references or depends on this advisory workflow" {
  if grep -lE 'ios-xcode27-advisory|iOS Xcode 27 Build|run-xcode27' .github/workflows/* | grep -v '^.github/workflows/ios-xcode27-advisory.yml$'; then
    return 1
  fi
}

@test "the required iOS gate does not depend on the Xcode 27 job" {
  run grep -n "xcode27\|Xcode 27" .github/workflows/pull_request.yml
  [ "${status}" -eq 1 ]
}
