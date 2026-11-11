#!/usr/bin/env bash
#
# Installs the Fast Validation job's extra CLI dependencies (xmlstarlet, bats,
# and lychee) with bounded, retrying network calls.
#
# The Fast Validation "Install fast validation dependencies" step runs four
# network operations -- `apt-get update`, `apt-get install`, a `git clone` of
# bats-core, and a lychee download -- as a `background: true` step. Native
# parallel-step failure surfaces at the `- wait:` barrier, so when a stalled
# apt mirror or GitHub TCP read never returns, the command blocks with no
# output, the wait never completes, and the whole 20-minute job budget can be
# consumed before the run is cancelled by timeout. Wrapping each call in a
# per-command wall-clock timeout
# plus exponential-backoff retry turns an indefinite hang into a fast, retried,
# and ultimately loud failure. The workflow step also carries `timeout-minutes`
# as a hard backstop.
#
# xmlstarlet comes from apt through scripts/ci/install-apt-packages.sh, the
# shared bounded installer: a failed or stalled `apt-get update` or install on
# the default Azure Ubuntu mirror falls back to an alternate mirror
# (FAST_VALIDATION_DEPS_FALLBACK_MIRROR) through a throwaway sources list,
# leaving the system sources untouched (#17131, #17930). Before #17930 a failed
# `apt-get update` here was fatal, so a mirror outage that broke the index
# fetch never reached the fallback. When xmlstarlet is already on PATH, apt is
# skipped entirely.
set -euo pipefail

# Tunables (overridable for tuning and for the BATS tests).
#
# Defaults are sized so the WORST CASE fits the workflow step's
# `timeout-minutes: 15` backstop: 5 retried operations (the apt helper's
# update, install and alternate-mirror fallback, each given CMD_TIMEOUT, plus
# bats clone and bats install) x (MAX_ATTEMPTS x (CMD_TIMEOUT + KILL_GRACE) +
# retry delays) = 5 x (2 x (60 + 10) + 5) = 725s, plus one lychee install bounded by LYCHEE_TIMEOUT + KILL_GRACE =
# 150 + 10 = 160s, for 885s < 900s. Healthy runs finish in seconds; a stalled
# mirror that cannot answer in 60s will not answer in 180s either. Keep this
# arithmetic aligned when changing any of these values or the step timeout.
#
# The lychee install is not wrapped in try_with_retry: install_lychee.sh fetches
# through scripts/lib/release-download.sh, which reuses a checksum-verified
# cache and owns the bounded download backoff (#17641). It gets one attempt
# with a timeout long enough for that backoff (about 60-90 s of waits), so a
# GitHub release outage ends with the helper's UPSTREAM-DOWNLOAD-FAILURE line
# instead of being killed at 60 s and retried from scratch.
CMD_TIMEOUT_SECONDS="${FAST_VALIDATION_DEPS_CMD_TIMEOUT_SECONDS:-60}"
KILL_GRACE_SECONDS="${FAST_VALIDATION_DEPS_KILL_GRACE_SECONDS:-10}"
MAX_ATTEMPTS="${FAST_VALIDATION_DEPS_MAX_ATTEMPTS:-2}"
RETRY_BASE_DELAY_SECONDS="${FAST_VALIDATION_DEPS_RETRY_BASE_DELAY_SECONDS:-5}"
LYCHEE_TIMEOUT_SECONDS="${FAST_VALIDATION_DEPS_LYCHEE_TIMEOUT_SECONDS:-150}"
BATS_CLONE_DIR="${FAST_VALIDATION_DEPS_BATS_CLONE_DIR:-/tmp/bats-core}"
BATS_INSTALL_PREFIX="${FAST_VALIDATION_DEPS_BATS_INSTALL_PREFIX:-/usr/local}"
# bats-core is installed with sudo, so pin it to a release and verify the
# commit (tags are mutable). Keep in step with the workflow installs.
BATS_CORE_TAG="v1.14.0"
BATS_CORE_COMMIT="eb7f42f8d608ac693d7a4b67474f6714ea68cfc5"
XMLSTARLET_COMMAND="${FAST_VALIDATION_DEPS_XMLSTARLET_COMMAND:-xmlstarlet}"
FALLBACK_MIRROR="${FAST_VALIDATION_DEPS_FALLBACK_MIRROR:-http://archive.ubuntu.com/ubuntu}"
APT_INSTALLER="$(dirname "${BASH_SOURCE[0]}")/install-apt-packages.sh"

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

# Run a command the way an `if` condition would (errexit is ignored inside it)
# and record its exit status in RUN_STATUS, so callers can branch on it without
# a function name in a condition.
RUN_STATUS=0
run_capture_status() {
local run_rc=0
"$@" || run_rc=$?
RUN_STATUS="${run_rc}"
}

# Run "$@" under a wall-clock timeout, retrying with exponential backoff.
#
# Each attempt is bounded by CMD_TIMEOUT_SECONDS so a network stall cannot hang
# forever; `timeout` sends SIGTERM on expiry and, after KILL_GRACE_SECONDS,
# SIGKILL (-k) so a child that ignores SIGTERM cannot linger. A timeout exits
# 124 and is treated as a retryable failure, as is any other non-zero exit.
try_with_retry() {
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
      log "${description} failed after ${MAX_ATTEMPTS} attempts (last exit ${status})"
      return 1
    fi

    log "Retrying ${description} in ${delay}s..."
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

# Like try_with_retry, but a final failure is fatal.
run_with_retry() {
  local description="$1"
  run_capture_status try_with_retry "$@"
  if [[ "$RUN_STATUS" -ne 0 ]]; then
    die "${description} failed after ${MAX_ATTEMPTS} attempts"
  fi
}

main() {
  local var
  for var in CMD_TIMEOUT_SECONDS KILL_GRACE_SECONDS MAX_ATTEMPTS RETRY_BASE_DELAY_SECONDS LYCHEE_TIMEOUT_SECONDS; do
    run_capture_status is_positive_integer "${!var}"
    if [[ "$RUN_STATUS" -ne 0 ]]; then
      die "${var} must be a positive integer (got '${!var}')"
    fi
  done

  if command -v "$XMLSTARLET_COMMAND" > /dev/null 2>&1; then
    log "xmlstarlet already on PATH; skipping apt-get"
  else
    # The helper owns its retries and mirror fallback; hand it this script's
    # tunables so the step budget above covers its three bounded operations.
    local apt_status=0
    APT_INSTALL_UPDATE_TIMEOUT_SECONDS="$CMD_TIMEOUT_SECONDS" \
      APT_INSTALL_TIMEOUT_SECONDS="$CMD_TIMEOUT_SECONDS" \
      APT_INSTALL_FALLBACK_TIMEOUT_SECONDS="$CMD_TIMEOUT_SECONDS" \
      APT_INSTALL_KILL_GRACE_SECONDS="$KILL_GRACE_SECONDS" \
      APT_INSTALL_MAX_ATTEMPTS="$MAX_ATTEMPTS" \
      APT_INSTALL_RETRY_BASE_DELAY_SECONDS="$RETRY_BASE_DELAY_SECONDS" \
      APT_INSTALL_FALLBACK_MIRROR="$FALLBACK_MIRROR" \
      APT_INSTALL_UBUNTU_CODENAME="${FAST_VALIDATION_DEPS_UBUNTU_CODENAME:-}" \
      bash "$APT_INSTALLER" xmlstarlet || apt_status=$?
    if [[ "$apt_status" -ne 0 ]]; then
      die "install xmlstarlet failed with exit ${apt_status}"
    fi
  fi

  if command -v bats > /dev/null 2>&1; then
    log "bats already on PATH; skipping source install"
  else
    # The pre-clone cleanup must run inside the retried command: a clone that
    # times out mid-transfer leaves a non-empty target directory, and without
    # per-attempt cleanup every subsequent retry would fail instantly on it.
    # `timeout` is an external binary and cannot run a shell function, so the
    # cleanup+clone pair is composed with `bash -c`.
    run_with_retry "clone bats-core" \
      bash -c "rm -rf \"\$1\" && git clone --depth 1 --branch \"\$2\" https://github.com/bats-core/bats-core.git \"\$1\"" \
      _ "$BATS_CLONE_DIR" "$BATS_CORE_TAG"
    bats_commit="$(git -C "$BATS_CLONE_DIR" rev-parse HEAD)"
    [[ "$bats_commit" == "$BATS_CORE_COMMIT" ]] ||
      die "bats-core ${BATS_CORE_TAG} resolved to ${bats_commit}, expected ${BATS_CORE_COMMIT}"
    run_with_retry "install bats-core" \
      sudo "${BATS_CLONE_DIR}/install.sh" "$BATS_INSTALL_PREFIX"
  fi

  log "install lychee (timeout ${LYCHEE_TIMEOUT_SECONDS}s; the installer retries its own download)"
  local lychee_status=0
  timeout -k "$KILL_GRACE_SECONDS" "$LYCHEE_TIMEOUT_SECONDS" scripts/lychee/install_lychee.sh || lychee_status=$?
  if [[ "$lychee_status" -eq 124 ]]; then
    die "install lychee timed out after ${LYCHEE_TIMEOUT_SECONDS}s"
  elif [[ "$lychee_status" -ne 0 ]]; then
    die "install lychee failed with exit ${lychee_status}"
  fi

  log "Fast Validation dependencies ready"
}

main "$@"
