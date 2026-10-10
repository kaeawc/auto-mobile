#!/usr/bin/env bash
#
# Alert on a red Live Idle Release job (#11368). The job is advisory, so a failure never blocks
# a merge; this opens ONE labelled tracking issue, or comments on the already-open one, so a
# failing night is not silent. Deduped by a fixed label plus title, never one issue per night.
#
# Environment:
#   ALERT_JOB_STATUS       job status; anything but "failure" is a no-op
#   ALERT_RUN_URL          link to the failing run (required on failure)
#   ALERT_EVIDENCE_DIR     evidence directory; failed-scenarios.txt inside names the scenarios
#   ALERT_GH               gh binary (default gh); the test seam
set -euo pipefail

GH="${ALERT_GH:-gh}"
label="live-idle-release-nightly"
title="Live Idle Release nightly is failing"

if [[ "${ALERT_JOB_STATUS:-}" != "failure" ]]; then
  echo "live idle-release alert: job status '${ALERT_JOB_STATUS:-unset}'; nothing to report."
  exit 0
fi
run_url="${ALERT_RUN_URL:?ALERT_RUN_URL is required on failure}"

scenarios="unknown (the job failed before the scenarios finished; see the run log)"
list_file="${ALERT_EVIDENCE_DIR:-}/failed-scenarios.txt"
if [[ -n "${ALERT_EVIDENCE_DIR:-}" && -s "${list_file}" ]]; then
  scenarios="$(paste -sd ',' "${list_file}" | sed 's/,/, /g')"
fi

body="Failed scenarios: ${scenarios}
Run: ${run_url}

Evidence is in the run's live-idle-release-evidence artifact. This issue is updated by the nightly job; close it once the nightly is green."

"${GH}" label create "${label}" --description "Live Idle Release nightly failure tracking" --force > /dev/null ||
  echo "live idle-release alert: could not ensure label ${label}; continuing." >&2

existing="$("${GH}" issue list --state open --label "${label}" --json number,title \
  --jq "[.[] | select(.title == \"${title}\")][0].number // empty")"

if [[ -n "${existing}" ]]; then
  "${GH}" issue comment "${existing}" --body "${body}"
  echo "live idle-release alert: commented on #${existing}."
else
  "${GH}" issue create --title "${title}" --label "${label}" --body "${body}"
fi
