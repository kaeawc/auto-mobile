#!/usr/bin/env bats
# Wiring guard for the advisory visionOS simulator smoke workflow.

WORKFLOW=".github/workflows/visionos-smoke-advisory.yml"

# Print the effective jobs.visionos-smoke.if expression, parsed with the
# installed YAML parser (no shell parsing of YAML structure). Prints nothing
# when the job has no `if:`.
job_if() {
  bun -e 'import { load } from "js-yaml"; const wf = load(await Bun.file(process.argv[1]).text()); const v = wf?.jobs?.["visionos-smoke"]?.if; process.stdout.write(v === undefined ? "" : String(v));' "$1"
}

# Succeed only when the job-level `if:` of workflow file $1 carries every
# label, same-repo, and pool guard clause.
assert_job_guard() {
  local cond
  cond="$(job_if "$1")" || return 1
  [[ "${cond}" == *"contains(github.event.pull_request.labels.*.name, 'run-visionos-smoke')"* ]] || return 1
  [[ "${cond}" == *"github.event.pull_request.head.repo.full_name == github.repository"* ]] || return 1
  [[ "${cond}" == *"github.event.label.name == 'run-visionos-smoke'"* ]] || return 1
  [[ "${cond}" == "vars.AUTOMOBILE_MAC_POOLS_ENABLED == 'true' && "* ]] || return 1
}

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

@test "the job if: runs PRs only with the label on a same-repo head and only when the pool is enabled" {
  assert_job_guard "${WORKFLOW}"
}

@test "the job guard check fails when the job-level if: is weakened or removed" {
  local weakened="${BATS_TEST_TMPDIR}/weakened.yml" removed="${BATS_TEST_TMPDIR}/removed.yml"
  sed -E 's/^(    if: ).*/\1true/' "${WORKFLOW}" >"${weakened}"
  sed -E '/^    if: /d' "${WORKFLOW}" >"${removed}"
  # The guard clauses still appear elsewhere in the file (comments, concurrency),
  # so only a parse of the job field can tell these apart from the real workflow.
  [ "$(job_if "${weakened}")" = "true" ]
  [ -z "$(job_if "${removed}")" ]
  run assert_job_guard "${weakened}"
  [ "${status}" -ne 0 ]
  run assert_job_guard "${removed}"
  [ "${status}" -ne 0 ]
}

@test "the job runs on the self-hosted Macs" {
  grep -qF '["self-hosted","automobile-mac"]' "${WORKFLOW}"
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
