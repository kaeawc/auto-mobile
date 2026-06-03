#!/usr/bin/env bash

set -euo pipefail

MAX_ATTEMPTS="${GRADLE_RETRY_MAX_ATTEMPTS:-2}"
RETRY_DELAY_SECONDS="${GRADLE_RETRY_DELAY_SECONDS:-10}"
LOG_DIR="${GRADLE_RETRY_LOG_DIR:-${RUNNER_TEMP:-/tmp}/auto-mobile-gradle-retry}"

usage() {
  cat <<'USAGE'
Usage: run-gradle-with-retry.sh -- ./gradlew <tasks> [flags...]

Runs a Gradle command and retries once by default when the failure looks like
transient Maven or Gradle plugin repository resolution trouble.
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

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ $# -eq 0 ]]; then
  usage
  die "missing Gradle command"
fi

if ! is_positive_integer "$MAX_ATTEMPTS"; then
  die "GRADLE_RETRY_MAX_ATTEMPTS must be a positive integer"
fi

if ! is_positive_integer "$RETRY_DELAY_SECONDS"; then
  die "GRADLE_RETRY_DELAY_SECONDS must be a positive integer"
fi

mkdir -p "$LOG_DIR"

is_retryable_gradle_failure() {
  local log_file="$1"
  local retryable_pattern

  retryable_pattern=$(
    cat <<'PATTERN'
Could not resolve plugin artifact|Plugin \[id: .* was not found|Could not resolve all files for configuration|Could not GET|Could not HEAD|Read timed out|Connection timed out|Connection reset|SocketTimeoutException|ConnectTimeoutException|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|Received status code 5[0-9][0-9]|Remote host terminated the handshake|Premature EOF
PATTERN
  )

  grep -qiE "$retryable_pattern" "$log_file"
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

command=("$@")
attempt=1
exit_code=0

while [[ "$attempt" -le "$MAX_ATTEMPTS" ]]; do
  log_file="${LOG_DIR}/gradle-attempt-${attempt}.log"
  log "Running Gradle attempt ${attempt}/${MAX_ATTEMPTS}: ${command[*]}"

  if run_gradle_command "$log_file" "${command[@]}"; then
    if [[ "$attempt" -gt 1 ]]; then
      log "Gradle succeeded after retry."
    fi
    exit 0
  else
    exit_code=$?
  fi

  if [[ "$attempt" -eq "$MAX_ATTEMPTS" ]]; then
    log "Gradle failed after ${MAX_ATTEMPTS} attempt(s)."
    exit "$exit_code"
  fi

  if ! is_retryable_gradle_failure "$log_file"; then
    log "Failure did not match Maven/plugin repository retry patterns."
    exit "$exit_code"
  fi

  log "Retryable Maven/plugin repository failure detected."
  log "Retrying in ${RETRY_DELAY_SECONDS}s with refreshed dependency metadata."
  sleep "$RETRY_DELAY_SECONDS"

  stop_gradle_daemon "${command[0]}"

  if ! has_refresh_dependencies_flag "${command[@]}"; then
    command+=("--refresh-dependencies")
  fi

  attempt=$((attempt + 1))
done

exit "$exit_code"
