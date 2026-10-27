#!/usr/bin/env bash
#
# Make a red CircleCI `nightly-macos` job visible on GitHub (#11615). CircleCI posts no commit
# status for its scheduled pipeline, so this reads the finished nightly jobs through the CircleCI
# API and opens ONE labelled tracking issue, or comments on the already-open one, listing every red
# job with its job URL and uploaded artifact names. Deduped by a fixed label plus title, like
# open-live-idle-release-alert.sh; it never closes the issue.
#
# Runs on ubuntu (no macOS demand). Uses the existing CIRCLECI_TOKEN repository secret that
# merge.yml already uses; without it, or when CircleCI refuses it, the run skips with a notice.
#
# Environment:
#   CIRCLECI_TOKEN         CircleCI API token (optional; empty means skip)
#   NIGHTLY_WINDOW_HOURS   how far back a nightly pipeline counts (default 20: under a day, so yesterday's nightly never counts)
#   NIGHTLY_MAX_PAGES      pipeline-list pages to scan, 20 pipelines each (default 5)
#   ALERT_NOW_EPOCH        current time in epoch seconds (default: now); a test seam
#   ALERT_GH               gh binary (default gh); a test seam
#   ALERT_CURL             curl binary (default curl); a test seam
set -euo pipefail

GH="${ALERT_GH:-gh}"
CURL="${ALERT_CURL:-curl}"
api="https://circleci.com/api/v2"
project="project/gh/kaeawc/auto-mobile"
ui="https://app.circleci.com/pipelines/github/kaeawc/auto-mobile"
label="circleci-nightly-macos"
title="CircleCI nightly macOS jobs are failing"
workflow_name="nightly-macos"
red_statuses='["failed","infrastructure_fail","timedout","terminated-unknown","unauthorized"]'
window_hours="${NIGHTLY_WINDOW_HOURS:-20}"

if [[ -z "${CIRCLECI_TOKEN:-}" ]]; then
  echo "circleci nightly report: CIRCLECI_TOKEN is not configured; skipping."
  exit 0
fi

now="${ALERT_NOW_EPOCH:-$(date +%s)}"
cutoff=$((now - window_hours * 3600))
max_pages="${NIGHTLY_MAX_PAGES:-5}"
work="$(mktemp -d)"
# A refused CircleCI request returns 75 from cc, which runs in a command substitution; the EXIT
# trap turns that into a clean skip.
skip_status=75
cleanup() {
  local rc=$?
  rm -rf "${work}"
  if [[ "${rc}" -eq "${skip_status}" ]]; then
    exit 0
  fi
}
trap 'cleanup' EXIT

# cc <path-or-query> -> body on stdout. 401/403/404 skip the whole run (bad token or no project
# access) and never print the response body, which can echo auth data. Messages go to stderr
# because callers capture stdout.
cc() {
  local status
  status="$("${CURL}" -sS -o "${work}/body" -w '%{http_code}' -H "Circle-Token: ${CIRCLECI_TOKEN}" \
    "${api}/$1" 2> /dev/null || echo 000)"
  case "${status}" in
    401 | 403 | 404)
      echo "circleci nightly report: CircleCI refused the request (HTTP ${status}); check CIRCLECI_TOKEN and project access. Skipping." >&2
      return "${skip_status}"
      ;;
    2[0-9][0-9]) cat "${work}/body" ;;
    *)
      echo "circleci nightly report: CircleCI request failed (HTTP ${status})." >&2
      exit 1
      ;;
  esac
}

# jq program fragment; $cutoff is a jq variable, not a shell expansion.
in_window="(.created_at | sub(\"\\\\.[0-9]+\"; \"\") | fromdateiso8601) >= \$cutoff"

# Recent main pipelines (the setup pipeline and its continuation) inside the window.
pipelines="${work}/pipelines.jsonl"
: > "${pipelines}"
page_token=""
for ((page = 0; page < max_pages; page++)); do
  query="${project}/pipeline?branch=main"
  [[ -z "${page_token}" ]] || query="${query}&page-token=${page_token}"
  body="$(cc "${query}")"
  jq -c --argjson cutoff "${cutoff}" ".items[]? | select(${in_window}) | {id, number}" \
    <<< "${body}" >> "${pipelines}"
  older_count="$(jq -r --argjson cutoff "${cutoff}" \
    "[.items[]? | select((${in_window}) | not)] | length" <<< "${body}")"
  page_token="$(jq -r '.next_page_token // empty' <<< "${body}")"
  [[ "${older_count}" == "0" && -n "${page_token}" ]] || break
done

# Red jobs of every nightly-macos workflow in those pipelines, one TSV row each.
red="${work}/red.tsv"
: > "${red}"
seen_nightly=0
while IFS= read -r pipeline; do
  pipeline_id="$(jq -r '.id' <<< "${pipeline}")"
  pipeline_number="$(jq -r '.number' <<< "${pipeline}")"
  workflows="$(cc "pipeline/${pipeline_id}/workflow")"
  while IFS= read -r workflow_id; do
    seen_nightly=1
    jobs="$(cc "workflow/${workflow_id}/job")"
    jq -r --argjson red "${red_statuses}" --arg pn "${pipeline_number}" --arg wf "${workflow_id}" \
      '.items[]? | select(.status as $s | $red | index($s)) | [.name, .status, (.job_number // ""), $pn, $wf] | @tsv' \
      <<< "${jobs}" >> "${red}"
  done < <(jq -r --arg name "${workflow_name}" '.items[]? | select(.name == $name) | .id' <<< "${workflows}")
done < "${pipelines}"

if [[ "${seen_nightly}" == "0" ]]; then
  echo "circleci nightly report: no ${workflow_name} workflow in the last ${window_hours}h; nothing to report."
  exit 0
fi
if [[ ! -s "${red}" ]]; then
  echo "circleci nightly report: no red ${workflow_name} job; nothing to report."
  exit 0
fi

lines=""
while IFS=$'\t' read -r name job_status job_number pipeline_number workflow_id; do
  line="- ${name}: ${job_status}"
  if [[ -n "${job_number}" ]]; then
    job_url="${ui}/${pipeline_number}/workflows/${workflow_id}/jobs/${job_number}"
    line="${line}
  Job: ${job_url}
  Artifacts (${job_url}/artifacts):"
    # A pruned job (404) must not abort the report: list it with no artifacts instead. cc handles
    # every failure itself (it returns the skip status or exits non-zero inside the command
    # substitution), so errexit is suspended only around this one call to read its status.
    set +e
    artifacts_json="$(cc "${project}/${job_number}/artifacts")"
    artifacts_status=$?
    set -e
    [[ "${artifacts_status}" -eq 0 ]] || artifacts_json='{"items":[]}'
    artifacts="$(jq -r '[.items[]?.path] | unique | .[:15][]' <<< "${artifacts_json}")"
    if [[ -n "${artifacts}" ]]; then
      while IFS= read -r path; do
        line="${line}
    - ${path}"
      done <<< "${artifacts}"
    else
      line="${line}
    - none uploaded"
    fi
  fi
  lines="${lines}${line}
"
done < "${red}"

body="Red jobs in the latest CircleCI nightly-macos workflow:
${lines}
Triage: the macOS BATS Shell Tests job uploads bats-unit-joblog/bats-unit-joblog-durations.tsv (per-file durations); the XCTestRunner Thread Sanitizer job uploads xctestrunner-tsan/ (TSan logs). Open the job URL above, then its Artifacts tab.

This issue is updated by the scheduled .github/workflows/circleci-nightly-visibility.yml; close it once the nightly is green."

"${GH}" label create "${label}" --description "CircleCI nightly macOS failure tracking" --force > /dev/null ||
  echo "circleci nightly report: could not ensure label ${label}; continuing." >&2

existing="$("${GH}" issue list --state open --label "${label}" --json number,title \
  --jq "[.[] | select(.title == \"${title}\")][0].number // empty")"

if [[ -n "${existing}" ]]; then
  "${GH}" issue comment "${existing}" --body "${body}"
  echo "circleci nightly report: commented on #${existing}."
else
  "${GH}" issue create --title "${title}" --label "${label}" --body "${body}"
fi
