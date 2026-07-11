#!/usr/bin/env bash
#
# Daemon Lifecycle Test
#
# Starts the AutoMobile daemon, runs health and doctor checks, then stops it.
# Logs each step to ci-logs/ for upload on failure.
#
# Usage:
#   ./scripts/ci/daemon-lifecycle.sh

set -uo pipefail

export PATH="${HOME}/.bun/bin:${PATH}"
mkdir -p ci-logs

# Run a daemon command, tee its output to a log, and return the *bun* exit
# status rather than tee's. Without this (and with no `set -e`), a failing
# `start`/`health` was silently ignored and the script's exit status only
# reflected the final `stop` — so the lifecycle step passed green even when
# the daemon never started (#3640).
run_step() {
  local log="$1"
  shift
  bun dist/src/index.js "$@" 2>&1 | tee "${log}"
  return "${PIPESTATUS[0]}"
}

if ! run_step ci-logs/daemon-start.log --daemon start; then
  echo "error: daemon start failed" >&2
  exit 1
fi

if ! run_step ci-logs/daemon-health.log --daemon health; then
  echo "error: daemon health check failed" >&2
  # Best-effort stop so we don't leak a daemon on the runner.
  run_step ci-logs/daemon-stop.log --daemon stop || true
  exit 1
fi

# Doctor exits non-zero when checks fail (expected on CI without devices).
# We just verify the daemon responds to the request.
run_step ci-logs/daemon-doctor.log --cli doctor --json || true

if ! run_step ci-logs/daemon-stop.log --daemon stop; then
  echo "error: daemon stop failed" >&2
  exit 1
fi
