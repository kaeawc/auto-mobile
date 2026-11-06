#!/usr/bin/env bats
# Wiring guard for the advisory visionOS simulator smoke workflow.
# Every structural assertion reads the workflow through the installed YAML
# parser, so a commented-out or re-indented line cannot satisfy it.

WORKFLOW=".github/workflows/visionos-smoke-advisory.yml"
UPLOAD_STEP="Upload smoke output"

# Parse workflow file $1 and print the value of the JavaScript expression $2,
# evaluated with the parsed document bound to `wf`. Strings print raw, other
# values as JSON, and undefined prints nothing.
wf_query() {
  bun -e '
    import { load } from "js-yaml";
    const wf = load(await Bun.file(process.argv[1]).text());
    const v = new Function("wf", `return (${process.argv[2]});`)(wf);
    process.stdout.write(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
  ' "$1" "$2"
}

# Print the effective jobs.visionos-smoke.if expression. Prints nothing when
# the job has no `if:`.
job_if() {
  wf_query "$1" 'wf?.jobs?.["visionos-smoke"]?.if'
}

# Print the effective `if:` of the upload step. Prints nothing when the step
# has no `if:` or is missing.
upload_step_if() {
  wf_query "$1" "wf?.jobs?.[\"visionos-smoke\"]?.steps?.find((s) => s?.name === \"${UPLOAD_STEP}\")?.if"
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

# Succeed only when the upload step of workflow file $1 runs even after a
# failed smoke step.
assert_upload_always() {
  local cond
  cond="$(upload_step_if "$1")" || return 1
  [ "${cond}" = "always()" ]
}

@test "triggers are pull_request, schedule, workflow_dispatch in order" {
  run wf_query "${WORKFLOW}" 'Object.keys(wf.on).join(",")'
  [ "${status}" -eq 0 ]
  [ "${output}" = "pull_request,schedule,workflow_dispatch" ]
}

@test "the single job is advisory and clearly named" {
  [ "$(wf_query "${WORKFLOW}" 'Object.keys(wf.jobs).join(",")')" = "visionos-smoke" ]
  [ "$(wf_query "${WORKFLOW}" 'wf.jobs["visionos-smoke"].name')" = "visionOS Smoke (Advisory)" ]
  [ "$(wf_query "${WORKFLOW}" 'wf.jobs["visionos-smoke"]["continue-on-error"]')" = "true" ]
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
  run wf_query "${WORKFLOW}" 'wf.jobs["visionos-smoke"]["runs-on"]'
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'["self-hosted","automobile-mac"]'* ]]
}

@test "it runs the smoke script and uploads its output" {
  run wf_query "${WORKFLOW}" 'wf.jobs["visionos-smoke"].steps.some((s) => typeof s.run === "string" && s.run.includes("bash scripts/visionos/smoke-visionos-simulator.sh"))'
  [ "${output}" = "true" ]
  run wf_query "${WORKFLOW}" "wf.jobs[\"visionos-smoke\"].steps.find((s) => s.name === \"${UPLOAD_STEP}\")?.uses ?? \"\""
  [[ "${output}" == actions/upload-artifact@* ]]
}

@test "the upload step keeps the smoke output even on failure" {
  assert_upload_always "${WORKFLOW}"
}

@test "the upload check fails when the step's if: always() is commented out or removed" {
  local commented="${BATS_TEST_TMPDIR}/commented.yml" removed="${BATS_TEST_TMPDIR}/removed.yml"
  sed -E 's/^(        )(if: always\(\))$/\1# \2/' "${WORKFLOW}" >"${commented}"
  sed -E '/^        if: always\(\)$/d' "${WORKFLOW}" >"${removed}"
  # Both edits must have changed the file, or the negative cases prove nothing.
  run cmp -s "${WORKFLOW}" "${commented}"
  [ "${status}" -ne 0 ]
  run cmp -s "${WORKFLOW}" "${removed}"
  [ "${status}" -ne 0 ]
  # The text `if: always()` still sits under the step in the commented copy,
  # so only the parsed step field can tell it apart from the real workflow.
  grep -qF '# if: always()' "${commented}"
  [ -z "$(upload_step_if "${commented}")" ]
  [ -z "$(upload_step_if "${removed}")" ]
  run assert_upload_always "${commented}"
  [ "${status}" -ne 0 ]
  run assert_upload_always "${removed}"
  [ "${status}" -ne 0 ]
}

@test "no required ruleset or other workflow depends on this advisory workflow" {
  # A reference search across other files, not a parse of this workflow's structure.
  if grep -lE 'visionos-smoke-advisory|visionOS Smoke \(Advisory\)|run-visionos-smoke' .github/workflows/* | grep -v '^.github/workflows/visionos-smoke-advisory.yml$'; then
    return 1
  fi
}
