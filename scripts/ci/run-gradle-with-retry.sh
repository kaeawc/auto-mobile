#!/usr/bin/env bash

set -euo pipefail

MAX_ATTEMPTS="${GRADLE_RETRY_MAX_ATTEMPTS:-2}"
RETRY_DELAY_SECONDS="${GRADLE_RETRY_DELAY_SECONDS:-10}"
MISSING_ARTIFACT_DELAY_SECONDS="${GRADLE_RETRY_MISSING_ARTIFACT_DELAY_SECONDS:-45}"
MISSING_ARTIFACT_PATTERN='Could not find [A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.+-]+'
LOG_DIR="${GRADLE_RETRY_LOG_DIR:-${RUNNER_TEMP:-/tmp}/auto-mobile-gradle-retry}"

usage() {
  cat <<'USAGE'
Usage: run-gradle-with-retry.sh -- ./gradlew <tasks> [flags...]

Runs a Gradle command and retries once by default when the failure looks like
transient Maven or Gradle plugin repository resolution trouble, including DNS
name-resolution failures reaching those hosts.

Environment:
  GRADLE_RETRY_MAX_ATTEMPTS                    Positive integer (default: 2)
  GRADLE_RETRY_DELAY_SECONDS                   Positive integer (default: 10)
  GRADLE_RETRY_MISSING_ARTIFACT_DELAY_SECONDS   Positive integer (default: 45)

Missing group:artifact:version failures use the longer repository-propagation
backoff; other retryable failures use GRADLE_RETRY_DELAY_SECONDS.
USAGE
}

log() {
  echo "[run-gradle-with-retry] $*"
}

die() {
  echo "[run-gradle-with-retry] ERROR: $*" >&2
  exit 1
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}
# Static reference for indirect callers; this branch never executes.
if false; then is_positive_integer "$@"; fi

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

# Run a command the way an `if` condition would (errexit is ignored inside it)
# and record its exit status in RUN_STATUS, so callers can branch on it without
# a function name in a condition.
RUN_STATUS=0
run_capture_status() {
local run_rc=0
"$@" || run_rc=$?
RUN_STATUS="${run_rc}"
}

if [[ $# -eq 0 ]]; then
  usage
  die "missing Gradle command"
fi

run_capture_status is_positive_integer "$MAX_ATTEMPTS"
if (( RUN_STATUS != 0 )); then
  die "GRADLE_RETRY_MAX_ATTEMPTS must be a positive integer"
fi

run_capture_status is_positive_integer "$RETRY_DELAY_SECONDS"
if (( RUN_STATUS != 0 )); then
  die "GRADLE_RETRY_DELAY_SECONDS must be a positive integer"
fi

[[ "$MISSING_ARTIFACT_DELAY_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
  die "GRADLE_RETRY_MISSING_ARTIFACT_DELAY_SECONDS must be a positive integer"

mkdir -p "$LOG_DIR"

is_retryable_gradle_failure() {
  local log_file="$1"
  local retryable_pattern

  retryable_pattern=$(
    cat <<'PATTERN'
Could not resolve plugin artifact|Plugin \[id: .* was not found|Could not resolve all files for configuration|Could not resolve all dependencies for configuration|Could not resolve all artifacts for configuration|Could not GET|Could not HEAD|Read timed out|Connection timed out|Connection reset|SocketTimeoutException|ConnectTimeoutException|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|Received status code 5[0-9][0-9]|Remote host terminated the handshake|Premature EOF|UnknownHostException|Temporary failure in name resolution|Name or service not known|nodename nor servname provided|No such host is known
PATTERN
  )

  grep -qiE "${retryable_pattern}|${MISSING_ARTIFACT_PATTERN}" "$log_file"
}
# Static reference for indirect callers; this branch never executes.
if false; then is_retryable_gradle_failure "$@"; fi

# A restored dependency cache can hold module metadata whose jars are missing
# (partial restore, #12706). Gradle then reports ArtifactNotFoundException for
# artifacts that exist upstream, and --refresh-dependencies alone does not
# re-download them because the cached metadata still claims they are present.
PARTIAL_CACHE_PATTERN='ArtifactNotFoundException: Could not find [^ ]+\.(jar|aar|pom|module)'

purge_resolved_module_cache() {
  local gradle_home="${GRADLE_USER_HOME:-$HOME/.gradle}"
  local modules_dir="${gradle_home}/caches/modules-2"

  if [[ -d "$modules_dir" ]]; then
    log "Partial dependency cache detected; purging ${modules_dir}."
    rm -rf "$modules_dir"
  fi
}

has_refresh_dependencies_flag() {
  local arg

  for arg in "$@"; do
    if [[ "$arg" == "--refresh-dependencies" ]]; then
      return 0
    fi
  done

  return 1
}
# Static reference for indirect callers; this branch never executes.
if false; then has_refresh_dependencies_flag "$@"; fi

stop_gradle_daemon() {
  local gradle_cmd="$1"

  if [[ -x "$gradle_cmd" ]]; then
    "$gradle_cmd" --stop >/dev/null 2>&1 || true
  fi
}

run_gradle_command() {
  local log_file="$1"
  shift

  set +e
  "$@" 2>&1 | tee "$log_file"
  local exit_code=${PIPESTATUS[0]}
  set -e

  return "$exit_code"
}
# Static reference for indirect callers; this branch never executes.
if false; then run_gradle_command "$@"; fi

command=("$@")
attempt=1
exit_code=0

while [[ "$attempt" -le "$MAX_ATTEMPTS" ]]; do
  log_file="${LOG_DIR}/gradle-attempt-${attempt}.log"
  log "Running Gradle attempt ${attempt}/${MAX_ATTEMPTS}: ${command[*]}"

  run_capture_status run_gradle_command "$log_file" "${command[@]}"
  if (( RUN_STATUS == 0 )); then
    if [[ "$attempt" -gt 1 ]]; then
      log "Gradle succeeded after retry."
    fi
    exit 0
  else
    exit_code="$RUN_STATUS"
  fi

  if [[ "$attempt" -eq "$MAX_ATTEMPTS" ]]; then
    log "Gradle failed after ${MAX_ATTEMPTS} attempt(s)."
    exit "$exit_code"
  fi

  run_capture_status is_retryable_gradle_failure "$log_file"
  if (( RUN_STATUS != 0 )); then
    log "Failure did not match Maven/plugin repository retry patterns."
    exit "$exit_code"
  fi

  delay_seconds="$RETRY_DELAY_SECONDS"
  if grep -qiE "$MISSING_ARTIFACT_PATTERN" "$log_file"; then
    delay_seconds="$MISSING_ARTIFACT_DELAY_SECONDS"
    log "Retryable missing-artifact (repository propagation) failure detected."
  else
    log "Retryable Maven/plugin repository failure detected."
  fi

  log "Retrying in ${delay_seconds}s with refreshed dependency metadata."
  sleep "$delay_seconds"

  stop_gradle_daemon "${command[0]}"

  if grep -qE "$PARTIAL_CACHE_PATTERN" "$log_file"; then
    purge_resolved_module_cache
  fi

  run_capture_status has_refresh_dependencies_flag "${command[@]}"
  if (( RUN_STATUS != 0 )); then
    command+=("--refresh-dependencies")
  fi

  attempt=$((attempt + 1))
done

exit "$exit_code"
