#!/usr/bin/env bash
# CircleCI can list an artifact before its blob is available (issue #8991).
# Re-list on every attempt, and publish only a successfully validated download.
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo 'Usage: fetch-circleci-swift-badge.sh <api> <project> <job-number> <output-path> (CIRCLECI_TOKEN required)' >&2
  exit 1
fi
if [[ -z "${CIRCLECI_TOKEN:-}" ]]; then
  echo '::error::CIRCLECI_TOKEN is required to fetch the Swift coverage badge' >&2
  exit 1
fi
if [[ -n "${BADGE_RETRY_SLEEP:-}" && ! "$BADGE_RETRY_SLEEP" =~ ^[0-9]+$ ]]; then
  echo '::error::BADGE_RETRY_SLEEP must be a non-negative integer' >&2
  exit 1
fi

api="${1%/}"
project="$2"
job_number="$3"
output_path="$4"
attempts=7
retry_delay=5
last_reason='no attempt completed'

mkdir -p "$(dirname "$output_path")"
# A previous badge must not survive an exhausted fetch and look like success.
rm -f "$output_path"
temp_file="$(mktemp "${output_path}.tmp.XXXXXX")"
trap 'rm -f "$temp_file"' EXIT
trap 'exit 1' HUP INT TERM

for ((attempt = 1; attempt <= attempts; attempt++)); do
  if artifacts="$(curl -fsS --connect-timeout 10 --max-time 20 \
    -H "Circle-Token: $CIRCLECI_TOKEN" \
    "$api/$project/$job_number/artifacts" 2>/dev/null)"; then
    if badge_url="$(jq -r '[.items[]? | select(.path | endswith("coverage/swift-coverage-badge.json")) | .url] | first // empty' \
      <<< "$artifacts" 2>/dev/null)"; then
      if [[ -n "$badge_url" ]]; then
        # Do not use curl's --retry: HTTP 404 is not one of its retry statuses.
        # Suppress raw curl/jq diagnostics so URLs or response data cannot leak
        # credentials; report only the HTTP status and controlled reason below.
        if http_status="$(curl -sSL --connect-timeout 10 --max-time 20 \
          -H "Circle-Token: $CIRCLECI_TOKEN" \
          -o "$temp_file" -w '%{http_code}' "$badge_url" 2>/dev/null)"; then
          if [[ "$http_status" == 2[0-9][0-9] ]]; then
            if jq -e . "$temp_file" >/dev/null 2>&1; then
              mv "$temp_file" "$output_path"
              echo "Fetched CircleCI Swift coverage badge for job $job_number (attempt $attempt/$attempts)"
              exit 0
            fi
            last_reason="download HTTP $http_status: invalid JSON"
          else
            last_reason="download HTTP ${http_status:-unknown}"
          fi
        else
          curl_exit=$?
          last_reason="download HTTP ${http_status:-unknown}: curl exit $curl_exit"
        fi
      else
        last_reason='artifact listing has no Swift coverage badge artifact'
      fi
    else
      last_reason='invalid artifact listing JSON'
    fi
  else
    curl_exit=$?
    last_reason="artifact listing request failed: curl exit $curl_exit"
  fi

  echo "CircleCI job $job_number badge attempt $attempt/$attempts failed: $last_reason" >&2
  if ((attempt < attempts)); then
    sleep "${BADGE_RETRY_SLEEP:-$retry_delay}"
    retry_delay=$((retry_delay * 2))
    if ((retry_delay > 40)); then
      retry_delay=40
    fi
  fi
done

# Exit 3 (distinct from 1) lets callers skip when the job never published a badge.
if [[ "$last_reason" == 'artifact listing has no Swift coverage badge artifact' ]]; then
  echo "::warning::CircleCI job $job_number published no Swift coverage badge artifact after $attempts attempts" >&2
  exit 3
fi
echo "::error::Failed to fetch CircleCI Swift coverage badge after $attempts attempts for job $job_number: $last_reason" >&2
exit 1
