#!/usr/bin/env bash
#
# Installs Ubuntu packages on a hosted CI runner with bounded, retrying apt
# calls and an alternate-mirror fallback.
#
# Usage: scripts/ci/install-apt-packages.sh <package>...
#
# A bare `sudo apt-get install` has no wall-clock bound. The default Azure
# Ubuntu mirror can answer `apt-get update` and then trickle .deb downloads:
# the WebRTC Publisher Integration job spent its whole 20-minute budget fetching
# ffmpeg's 62 MB of dependencies (#17131) and was cancelled with no diagnostic.
# Here every apt call runs under `timeout`, retried with exponential backoff
# (partial downloads in /var/cache/apt/archives/partial resume on retry). When
# the default mirror is exhausted, update+install re-run once more against
# APT_INSTALL_FALLBACK_MIRROR through a throwaway sources list, and a final
# failure exits non-zero with a ::error:: annotation naming the packages.
#
# A healthy mirror fetches ffmpeg's 62 MB in about 5s. Worst case with the
# defaults: update 2 x (60 + 10) + 5, install 2 x (90 + 10) + 5, fallback
# 2 x (120 + 10) + 5 = 615s, which leaves a 20-minute job room to report the
# failure. Keep this arithmetic aligned with the callers' job timeouts.
set -euo pipefail

UPDATE_TIMEOUT_SECONDS="${APT_INSTALL_UPDATE_TIMEOUT_SECONDS:-60}"
INSTALL_TIMEOUT_SECONDS="${APT_INSTALL_TIMEOUT_SECONDS:-90}"
FALLBACK_TIMEOUT_SECONDS="${APT_INSTALL_FALLBACK_TIMEOUT_SECONDS:-120}"
KILL_GRACE_SECONDS="${APT_INSTALL_KILL_GRACE_SECONDS:-10}"
MAX_ATTEMPTS="${APT_INSTALL_MAX_ATTEMPTS:-2}"
RETRY_BASE_DELAY_SECONDS="${APT_INSTALL_RETRY_BASE_DELAY_SECONDS:-5}"
FALLBACK_MIRROR="${APT_INSTALL_FALLBACK_MIRROR:-http://archive.ubuntu.com/ubuntu}"
SELF="${BASH_SOURCE[0]}"

log() {
  echo "[install-apt-packages] $*"
}

die() {
  echo "::error title=apt install failed::$*"
  echo "[install-apt-packages] ERROR: $*" >&2
  exit 1
}

# Runs "$@" the way an `if` condition would (errexit is ignored inside it) and
# records its exit status in RUN_STATUS, so callers branch on it without a
# function name in a condition.
RUN_STATUS=0
run_capture_status() {
  local run_rc=0
  "$@" || run_rc=$?
  RUN_STATUS="${run_rc}"
}

# Runs "$@" under a wall-clock timeout of $2 seconds, retrying with exponential
# backoff. A leading `sudo` is hoisted outside the timeout. `timeout -k` escalates to SIGKILL after KILL_GRACE_SECONDS so a child
# that ignores SIGTERM cannot linger. Exit 124 (timed out) and any other
# non-zero exit are both retried. Returns 1 once MAX_ATTEMPTS are exhausted.
try_with_retry() {
  local description="$1"
  local limit="$2"
  shift 2
  local attempt=1
  local delay="$RETRY_BASE_DELAY_SECONDS"
  local status
  while true; do
    log "${description} (attempt ${attempt}/${MAX_ATTEMPTS}, timeout ${limit}s)"
    status=0
    if [[ "$1" == "sudo" ]]; then
      # Run timeout under sudo, not around it: timeout cannot signal the root
      # apt-get through an unprivileged sudo, and an apt-get that outlived its
      # attempt kept /var/lib/apt/lists/lock, so the retry failed at once
      # with "Could not get lock" (#17930).
      sudo timeout -k "$KILL_GRACE_SECONDS" "$limit" "${@:2}" || status=$?
    else
      timeout -k "$KILL_GRACE_SECONDS" "$limit" "$@" || status=$?
    fi
    if [[ "$status" -eq 0 ]]; then
      return 0
    fi
    if [[ "$status" -eq 124 ]]; then
      log "${description} timed out after ${limit}s"
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

# Runs as root (sudo + timeout re-invoke this script): update and install from
# FALLBACK_MIRROR via a throwaway sources list, leaving the system sources
# untouched. sudo resets the environment, so main passes the mirror and the
# codename through `env`.
install_from_fallback_mirror() {
  local codename="${APT_INSTALL_UBUNTU_CODENAME:-}"
  if [[ -z "$codename" && -r /etc/os-release ]]; then
    # Host OS metadata is unavailable on non-Linux analysis hosts.
    # shellcheck source=/dev/null
    codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
  fi
  codename="${codename:-noble}"
  local list status=0
  list="$(mktemp)"
  {
    echo "deb ${FALLBACK_MIRROR} ${codename} main universe"
    echo "deb ${FALLBACK_MIRROR} ${codename}-updates main universe"
    echo "deb ${FALLBACK_MIRROR} ${codename}-security main universe"
  } > "$list"
  local opts=(-o "Dir::Etc::sourcelist=${list}" -o "Dir::Etc::sourceparts=/dev/null")
  apt-get update "${opts[@]}" && apt-get install -y --no-install-recommends "${opts[@]}" "$@" || status=$?
  rm -f "$list"
  return "$status"
}

main() {
  if [[ "$#" -eq 0 ]]; then
    echo "Usage: scripts/ci/install-apt-packages.sh <package>..." >&2
    return 2
  fi
  local var
  for var in UPDATE_TIMEOUT_SECONDS INSTALL_TIMEOUT_SECONDS FALLBACK_TIMEOUT_SECONDS \
    KILL_GRACE_SECONDS MAX_ATTEMPTS RETRY_BASE_DELAY_SECONDS; do
    if ! [[ "${!var}" =~ ^[1-9][0-9]*$ ]]; then
      echo "[install-apt-packages] ERROR: ${var} must be a positive integer (got '${!var}')" >&2
      return 2
    fi
  done

  local packages="$*"
  local status=0
  # A failed update on the default mirror is not fatal: the fallback below
  # refreshes its own lists.
  run_capture_status try_with_retry "apt-get update" "$UPDATE_TIMEOUT_SECONDS" sudo apt-get update
  status="$RUN_STATUS"
  if [[ "$status" -eq 0 ]]; then
    run_capture_status try_with_retry "apt-get install ${packages}" "$INSTALL_TIMEOUT_SECONDS" \
      sudo apt-get install -y --no-install-recommends "$@"
    status="$RUN_STATUS"
  fi
  if [[ "$status" -eq 0 ]]; then
    log "Installed ${packages}"
    return 0
  fi

  log "Default mirror failed; falling back to ${FALLBACK_MIRROR}"
  run_capture_status try_with_retry "apt-get install ${packages} from ${FALLBACK_MIRROR}" "$FALLBACK_TIMEOUT_SECONDS" \
    sudo env \
    "APT_INSTALL_FALLBACK_MIRROR=${FALLBACK_MIRROR}" \
    "APT_INSTALL_UBUNTU_CODENAME=${APT_INSTALL_UBUNTU_CODENAME:-}" \
    bash "$SELF" --from-fallback-mirror "$@"
  if [[ "$RUN_STATUS" -ne 0 ]]; then
    die "could not install ${packages}: the default mirror and ${FALLBACK_MIRROR} both failed or stalled (see the timed attempts above); rerun the job"
  fi
  log "Installed ${packages} from ${FALLBACK_MIRROR}"
}

if [[ "${1:-}" == "--from-fallback-mirror" ]]; then
  shift
  install_from_fallback_mirror "$@"
else
  main "$@"
fi
