#!/usr/bin/env bash
#
# Installs the Fast Validation job's extra CLI dependencies (xmlstarlet + bats)
# with bounded, retrying network calls.
#
# The Fast Validation "Install fast validation dependencies" step runs three
# network operations -- `apt-get update`, `apt-get install`, and a `git clone`
# of bats-core -- as a `background: true` step. Native parallel-step failure
# surfaces at the `- wait:` barrier, so when a stalled apt mirror or GitHub TCP
# read never returns, the command blocks with no output, the wait never
# completes, and the whole 50-minute job budget is consumed before the run is
# cancelled by timeout. Wrapping each call in a per-command wall-clock timeout
# plus exponential-backoff retry turns an indefinite hang into a fast, retried,
# and ultimately loud failure. The workflow step also carries `timeout-minutes`
# as a hard backstop.
set -euo pipefail

# Tunables (overridable for tuning and for the BATS tests).
#
# Defaults are sized so the WORST CASE fits the workflow step's
# `timeout-minutes: 10` backstop: 4 operations x (MAX_ATTEMPTS x
# (CMD_TIMEOUT + KILL_GRACE) + retry delays) = 4 x (2 x (60 + 10) + 5) = 580s
# < 600s. Healthy runs finish in seconds; a stalled mirror that cannot answer
# in 60s will not answer in 180s either. Keep this arithmetic aligned when
# changing any of these values or the step timeout.
CMD_TIMEOUT_SECONDS="${FAST_VALIDATION_DEPS_CMD_TIMEOUT_SECONDS:-60}"
KILL_GRACE_SECONDS="${FAST_VALIDATION_DEPS_KILL_GRACE_SECONDS:-10}"
MAX_ATTEMPTS="${FAST_VALIDATION_DEPS_MAX_ATTEMPTS:-2}"
RETRY_BASE_DELAY_SECONDS="${FAST_VALIDATION_DEPS_RETRY_BASE_DELAY_SECONDS:-5}"
BATS_CLONE_DIR="${FAST_VALIDATION_DEPS_BATS_CLONE_DIR:-/tmp/bats-core}"
BATS_INSTALL_PREFIX="${FAST_VALIDATION_DEPS_BATS_INSTALL_PREFIX:-/usr/local}"

log() {
  echo "[install-fast-validation-deps] $*"
}

die() {
  echo "[install-fast-validation-deps] ERROR: $*" >&2
  exit 1
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

# Run "$@" under a wall-clock timeout, retrying with exponential backoff.
#
# Each attempt is bounded by CMD_TIMEOUT_SECONDS so a network stall cannot hang
# forever; `timeout` sends SIGTERM on expiry and, after KILL_GRACE_SECONDS,
# SIGKILL (-k) so a child that ignores SIGTERM cannot linger. A timeout exits
# 124 and is treated as a retryable failure, as is any other non-zero exit.
run_with_retry() {
  local description="$1"
  shift

  local attempt=1
  local delay="$RETRY_BASE_DELAY_SECONDS"
  local status=0

  while true; do
    log "${description} (attempt ${attempt}/${MAX_ATTEMPTS}, timeout ${CMD_TIMEOUT_SECONDS}s)"
    # Capture the real exit code in the condition: a bare `if cmd; then ...; fi`
    # with no `else` reports status 0 for the compound statement, so reading
    # `$?` after `fi` would always see 0 rather than the command's exit.
    status=0
    timeout -k "$KILL_GRACE_SECONDS" "$CMD_TIMEOUT_SECONDS" "$@" || status=$?
    if [[ "$status" -eq 0 ]]; then
      return 0
    fi

    if [[ "$status" -eq 124 ]]; then
      log "${description} timed out after ${CMD_TIMEOUT_SECONDS}s"
    else
      log "${description} failed with exit ${status}"
    fi

    if [[ "$attempt" -ge "$MAX_ATTEMPTS" ]]; then
      die "${description} failed after ${MAX_ATTEMPTS} attempts (last exit ${status})"
    fi

    log "Retrying ${description} in ${delay}s..."
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

main() {
  local var
  for var in CMD_TIMEOUT_SECONDS KILL_GRACE_SECONDS MAX_ATTEMPTS RETRY_BASE_DELAY_SECONDS; do
    if ! is_positive_integer "${!var}"; then
      die "${var} must be a positive integer (got '${!var}')"
    fi
  done

  run_with_retry "apt-get update" sudo apt-get update
  run_with_retry "apt-get install xmlstarlet" sudo apt-get install -y xmlstarlet

  if command -v bats > /dev/null 2>&1; then
    log "bats already on PATH; skipping source install"
  else
    # The pre-clone cleanup must run inside the retried command: a clone that
    # times out mid-transfer leaves a non-empty target directory, and without
    # per-attempt cleanup every subsequent retry would fail instantly on it.
    # `timeout` is an external binary and cannot run a shell function, so the
    # cleanup+clone pair is composed with `bash -c`.
    # shellcheck disable=SC2016 # $1 is deliberately expanded by the inner bash, not here.
    run_with_retry "clone bats-core" \
      bash -c 'rm -rf "$1" && git clone --depth 1 https://github.com/bats-core/bats-core.git "$1"' \
      _ "$BATS_CLONE_DIR"
    run_with_retry "install bats-core" \
      sudo "${BATS_CLONE_DIR}/install.sh" "$BATS_INSTALL_PREFIX"
  fi

  log "Fast Validation dependencies ready"
}

main "$@"
