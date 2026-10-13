#!/usr/bin/env bash
# Advisory queue visibility (#11580), using GitHub-hosted Linux gh/jq/timeout.
# Watches self-hosted jobs that exist while it runs; exits once none is queued.
# Later Prototype Simulator (needs ios-xcode-build) is deliberately unwatched:
# avoid holding Linux for the whole Mac phase. It is advisory and follows a
# heavy-pool job.
# Usage: bash scripts/ci/mac-queue-watchdog.sh (GITHUB_* and GH_TOKEN from Actions).
# Requires Linux coreutils timeout to bound the script-owned API child.
set -euo pipefail

threshold="${MAC_QUEUE_STUCK_SECONDS:-900}"
interval="${MAC_QUEUE_POLL_SECONDS:-30}"
for value in "$threshold" "$interval"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo '::warning::Invalid Mac queue timing; queue could not be checked.'
    exit 0
  fi
done
if [[ -z "${GITHUB_REPOSITORY:-}" || -z "${GITHUB_RUN_ID:-}" || -z "${GH_TOKEN:-}" ]]; then
  echo '::warning::Missing API inputs; Mac queue could not be checked.'
  exit 0
fi
for command in gh jq timeout; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "::warning::Missing $command; Mac queue could not be checked."
    exit 0
  fi
done

# Clock injection keeps BATS instantaneous without altering queue-age semantics.
now_cmd="${MAC_QUEUE_NOW_CMD:-date}"
start="$("$now_cmd" +%s)"
deadline=$((start + threshold + 2 * interval))
first=1
started='[]'
endpoint="/repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs?per_page=100"
remedy='No runner in that pool is online or the pool is saturated; set the repository variable AUTOMOBILE_MAC_POOLS_ENABLED to any value other than true and re-run the workflow to move every Mac job to GitHub-hosted macOS (see docs/design-docs/ci/macos-capacity-plan.md).'

while :; do
  now="$("$now_cmd" +%s)"
  remaining=$((deadline - now))
  if (( remaining <= 0 )); then
    echo '::warning::Mac queue observation reached its runtime bound.'
    exit 0
  fi
  # Bound even a stalled API/pagination request. timeout only owns this gh child.
  if response="$(timeout --foreground --signal=KILL "${remaining}s" gh api --paginate "$endpoint" 2>/dev/null)" &&
    jobs="$(jq -ce -s '
      if length > 0 and all(.[]; (.jobs | type == "array")) then
        [.[].jobs[] | if (.id | type == "number") and
          (.name | type == "string") and (.labels | type == "array") and
          (.status | type == "string") and (.created_at | type == "string")
          then . + {created_epoch: (.created_at | fromdateiso8601)}
          else error("invalid job") end]
      else error("invalid jobs response") end' <<< "$response" 2>/dev/null)"; then
    now="$("$now_cmd" +%s)"
    started="$(jq -c --argjson seen "$started" '
      $seen + [.[] | select((.labels | index("self-hosted")) != null and
        (.status == "in_progress" or .status == "completed")) | .id] | unique' <<< "$jobs")"
    stuck="$(jq -r --argjson now "$now" --argjson threshold "$threshold" '
      .[] | select((.labels | index("self-hosted")) != null and .status == "queued") |
      ($now - .created_epoch) as $age | select($age >= $threshold) |
      "\(.name | gsub("[\r\n]"; " ")) (pool labels: \(.labels | map(select(. != "self-hosted") | gsub("[\r\n]"; " ")) | join(", "))); \(($age / 60) | floor) minutes waited"
      ' <<< "$jobs")"
    if [[ -n "$stuck" ]]; then
      while IFS= read -r job; do
        message="$job. $remedy"
        # Escape Actions command data so API job names cannot inject annotations.
        escaped="${message//%/%25}"
        escaped="${escaped//$'\r'/%0D}"
        printf '::error title=Self-hosted Mac queue::%s\n' "$escaped"
        if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
          printf '%s\n' "$message" >> "$GITHUB_STEP_SUMMARY"
        fi
      done <<< "$stuck"
      exit 1
    fi
    queued="$(jq '[.[] | select((.labels | index("self-hosted")) != null and .status == "queued")] | length' <<< "$jobs")"
    if (( first == 0 && queued == 0 )); then
      printf 'Self-hosted queue clear; saw %s self-hosted jobs start.\n' "$(jq length <<< "$started")"
      exit 0
    fi
  else
    echo '::warning::Unreadable jobs API response; continuing Mac queue observation.'
    now="$("$now_cmd" +%s)"
    if (( now - start >= threshold )); then
      echo '::warning::Mac queue could not be checked before the stuck threshold; advisory watchdog exiting.'
      exit 0
    fi
  fi
  first=0
  remaining=$((deadline - now))
  if (( remaining <= 0 )); then
    echo '::warning::Mac queue observation reached its runtime bound.'
    exit 0
  fi
  delay="$interval"
  if (( delay > remaining )); then delay="$remaining"; fi
  sleep "$delay"
done
