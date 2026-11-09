#!/usr/bin/env bash
# Per-run routing for the self-hosted Mac pools (#17580).
# Reads the repository's self-hosted runners and, for each pool with no online
# runner, routes that pool's jobs to GitHub-hosted macOS for this run only.
# Fails open: without the runner-read token, or when the API call fails, every
# pool stays self-hosted and the job summary says why.
#
# Usage: bash scripts/ci/mac-pool-routing.sh
# Env:   MAC_RUNNER_READ_TOKEN  token that can list repository runners
#                               (fine-grained: Administration read)
#        GITHUB_REPOSITORY, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY (from Actions)
#        MAC_POOL_ROUTING_TIMEOUT_SECONDS  API bound (default 30)
# Outputs (GITHUB_OUTPUT): small=<self-hosted|hosted>, heavy=<self-hosted|hosted>
set -euo pipefail

# Output key and runner label of each pool, in summary order.
pools=("small:automobile-mac" "heavy:automobile-mac-heavy")
timeout_seconds="${MAC_POOL_ROUTING_TIMEOUT_SECONDS:-30}"
doc='docs/design-docs/ci/macos-capacity-plan.md'

summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"
  fi
}

emit() {
  local key="$1" route="$2"
  printf '%s=%s\n' "$key" "$route"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$route" >> "$GITHUB_OUTPUT"
  fi
}

fail_open() {
  local reason="$1" entry
  printf '::warning title=Mac pool routing::%s Failing open: every Mac pool stays self-hosted for this run.\n' "$reason"
  summary '## Mac pool routing' '' \
    "**Failing open to self-hosted.** $reason" '' \
    'Every Mac pool stays self-hosted for this run, so an offline pool still queues;' \
    "the \`Mac Runner Queue\` watchdog reports it. See \`$doc\`."
  for entry in "${pools[@]}"; do
    emit "${entry%%:*}" self-hosted
  done
  exit 0
}

if [[ -z "${MAC_RUNNER_READ_TOKEN:-}" ]]; then
  fail_open 'The MAC_RUNNER_READ_TOKEN secret is not set, so runner status could not be read.'
fi
if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
  fail_open 'GITHUB_REPOSITORY is not set, so runner status could not be read.'
fi
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  fail_open 'MAC_POOL_ROUTING_TIMEOUT_SECONDS is not a positive integer.'
fi
for command in gh jq timeout; do
  if ! command -v "$command" >/dev/null 2>&1; then
    fail_open "$command is not installed, so runner status could not be read."
  fi
done

endpoint="/repos/$GITHUB_REPOSITORY/actions/runners?per_page=100"
# timeout owns only this gh child; never signal anything else.
if ! response="$(GH_TOKEN="$MAC_RUNNER_READ_TOKEN" timeout --foreground --signal=KILL \
  "${timeout_seconds}s" gh api --paginate "$endpoint" 2>/dev/null)"; then
  fail_open 'The runners API call failed or timed out (check that MAC_RUNNER_READ_TOKEN can read repository runners).'
fi
# --paginate concatenates one object per page; validate every page and runner.
if ! runners="$(jq -ce -s '
  if length > 0 and all(.[]; type == "object" and (.runners | type == "array")) then
    [.[].runners[] | if type == "object" and (.status | type == "string") and
      (.labels | type == "array") and all(.labels[]; (.name | type == "string"))
      then {status, labels: [.labels[].name]}
      else error("invalid runner") end]
  else error("invalid runners response") end' <<< "$response" 2>/dev/null)"; then
  fail_open 'The runners API returned an unreadable response.'
fi

summary '## Mac pool routing' '' \
  '| Pool | Online runners | Route |' \
  '| ---- | -------------- | ----- |'
fallback=0
for entry in "${pools[@]}"; do
  key="${entry%%:*}"
  label="${entry#*:}"
  # Exact label match: heavy runners must not carry the small label (and vice versa).
  read -r online total < <(jq -r --arg label "$label" '
    [.[] | select(.labels | index($label) != null)] |
    "\([.[] | select(.status == "online")] | length) \(length)"' <<< "$runners")
  # An online runner, busy or idle, takes the job once free; only an offline
  # pool falls back.
  if (( online > 0 )); then
    route=self-hosted
  else
    route=hosted
    fallback=1
    printf '::notice title=Mac pool routing::No online runner in %s (%s registered); its jobs run on hosted macOS for this run.\n' "$label" "$total"
  fi
  summary "| \`$label\` | $online of $total | $route |"
  emit "$key" "$route"
done
if (( fallback == 1 )); then
  summary '' 'Hosted fallback costs about 18-20 macOS minutes per iOS run and counts toward the' \
    "40-concurrent-job hosted cap. See \`$doc\`."
fi
