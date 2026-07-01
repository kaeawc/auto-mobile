#!/usr/bin/env bash
#
# Ensure AutoMobile Daemon Ready
#
# Verifies the `auto-mobile` CLI is installed and on PATH, then starts the daemon
# and waits (bounded backoff) for it to report healthy BEFORE the XCTestRunner
# Swift integration tests shell out to it. This turns a flaky, silently-skipped
# test ("Failed to start AutoMobile Daemon. Ensure auto-mobile is installed and
# on PATH.") into a loud, deterministic CI gate with a clear diagnostic (#2730).
#
# Root cause: `bun add -g .` installs the CLI under ~/.bun/bin, which is not on
# $GITHUB_PATH by default, so the `swift test` subprocess could not resolve
# `auto-mobile` and skipped the test.
#
# Usage:
#   ./scripts/ci/ensure-daemon-ready.sh
#
# Env overrides (used by tests to keep runs fast):
#   DAEMON_READY_MAX_ATTEMPTS   max health-poll attempts (default 30)
#   DAEMON_READY_DELAY_SECONDS  initial delay between polls, seconds (default 1)

set -uo pipefail

# Refresh PATH — `bun add -g .` installs the CLI under ~/.bun/bin, which is the
# exact gap that made `swift test` fail to resolve `auto-mobile`.
export PATH="${HOME}/.bun/bin:${PATH}"
hash -r 2>/dev/null || true

# Persist the bin dir for the *subsequent* workflow steps: `swift test` spawns
# `auto-mobile` as a child, so it needs the same PATH.
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${HOME}/.bun/bin" >> "${GITHUB_PATH}"
fi

if ! command -v auto-mobile >/dev/null 2>&1; then
  echo "::error::auto-mobile is not on PATH after global install (expected in ${HOME}/.bun/bin)." >&2
  echo "The XCTestRunner Swift tests cannot start the daemon without it. Did 'bun add -g .' run?" >&2
  exit 1
fi
echo "auto-mobile resolved at: $(command -v auto-mobile)"

# Start the daemon (idempotent — an already-running, version-matched daemon is
# reused by the Swift test's ensureDaemonRunning()).
auto-mobile --daemon start || true

max_attempts="${DAEMON_READY_MAX_ATTEMPTS:-30}"
delay="${DAEMON_READY_DELAY_SECONDS:-1}"
attempt=1
while (( attempt <= max_attempts )); do
  if auto-mobile --daemon health >/dev/null 2>&1; then
    echo "Daemon ready after ${attempt} attempt(s)."
    exit 0
  fi
  echo "Daemon not ready yet (attempt ${attempt}/${max_attempts}); retrying in ${delay}s..."
  sleep "${delay}"
  # Linear-capped backoff: 1s, 2s, ... up to 5s between polls.
  (( delay < 5 )) && (( delay++ ))
  (( attempt++ ))
done

echo "::error::AutoMobile daemon did not become ready after ${max_attempts} attempts." >&2
auto-mobile --daemon health >&2 || true
exit 1
