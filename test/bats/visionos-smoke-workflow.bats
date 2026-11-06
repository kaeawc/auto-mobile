#!/usr/bin/env bats
# Wiring guard for the advisory visionOS simulator smoke workflow.

WORKFLOW=".github/workflows/visionos-smoke-advisory.yml"

@test "triggers are pull_request, schedule, workflow_dispatch in order" {
  run awk '/^on:/{on=1; next} on && /^[^ #]/{exit} on && /^  [a-z_]+:/{print $1}' "${WORKFLOW}"
  [ "${status}" -eq 0 ]
  [ "${output}" = $'pull_request:\nschedule:\nworkflow_dispatch:' ]
}

@test "the single job is advisory and clearly named" {
  grep -qF 'name: "visionOS Smoke (Advisory)"' "${WORKFLOW}"
  grep -q '^    continue-on-error: true$' "${WORKFLOW}"
  [ "$(grep -c '^  [a-z0-9-]*:$' <(awk '/^jobs:/{j=1; next} j' "${WORKFLOW}"))" -eq 1 ]
}

@test "pull requests run only with the run-visionos-smoke label on a same-repo head" {
  grep -qF "contains(github.event.pull_request.labels.*.name, 'run-visionos-smoke')" "${WORKFLOW}"
  grep -qF 'github.event.pull_request.head.repo.full_name == github.repository' "${WORKFLOW}"
  grep -qF "github.event.label.name == 'run-visionos-smoke'" "${WORKFLOW}"
}

@test "the job runs on the self-hosted Macs only when the pool is enabled" {
  grep -qF '["self-hosted","automobile-mac"]' "${WORKFLOW}"
  grep -qF "vars.AUTOMOBILE_MAC_POOLS_ENABLED == 'true'" "${WORKFLOW}"
}

@test "it runs the smoke script and keeps its output even on failure" {
  grep -qF 'bash scripts/visionos/smoke-visionos-simulator.sh' "${WORKFLOW}"
  awk '/Upload smoke output/{f=1} f && /if: always\(\)/{ok=1} END{exit ok?0:1}' "${WORKFLOW}"
}

@test "no required ruleset or other workflow depends on this advisory workflow" {
  if grep -lE 'visionos-smoke-advisory|visionOS Smoke \(Advisory\)|run-visionos-smoke' .github/workflows/* | grep -v '^.github/workflows/visionos-smoke-advisory.yml$'; then
    return 1
  fi
}
