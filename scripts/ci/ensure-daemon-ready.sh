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
# Root cause: `bun add -g .` does not reliably produce a runnable `auto-mobile`
# bin on the CI runner — the global copy under ~/.bun/install can lack dist/,
# leaving a dangling ~/.bun/bin/auto-mobile symlink that resolves to nothing — and
# ~/.bun/bin is not on $GITHUB_PATH anyway. So the `swift test` subprocess could
# not resolve `auto-mobile` and the test silently skipped.
#
# Fix: put ~/.bun/bin on PATH/$GITHUB_PATH, and if `auto-mobile` still does not
# resolve, symlink it onto the freshly-built workspace entrypoint
# (dist/src/index.js, a `#!/usr/bin/env bun` executable that version-matches this
# checkout — the same entry scripts/ci/daemon-lifecycle.sh runs directly).
#
# Usage:
#   ./scripts/ci/ensure-daemon-ready.sh
#
# Env overrides (used by tests to keep runs fast):
#   DAEMON_READY_MAX_ATTEMPTS   max health-poll attempts (default 30)
#   DAEMON_READY_DELAY_SECONDS  initial delay between polls, seconds (default 1)
#   AUTOMOBILE_DAEMON_DEBUG      start the daemon with --debug when set to 1
#   AUTOMOBILE_DAEMON_EMBEDDED_SDK start the daemon with --embedded-sdk when set to 1

set -uo pipefail

REPO_ROOT="${GITHUB_WORKSPACE:-$PWD}"
DIST_ENTRY="${REPO_ROOT}/dist/src/index.js"
BUN_BIN_DIR="${HOME}/.bun/bin"

# Refresh PATH — `bun add -g .` installs under ~/.bun/bin, which is not otherwise
# on PATH here.
export PATH="${BUN_BIN_DIR}:${PATH}"
hash -r 2>/dev/null || true

# Use the standard 30s daemon startup ceiling on cold CI runners. An explicit
# outer override still wins.
export AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS="${AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS:-30000}"

# Persist the bin dir for the *subsequent* workflow steps: `swift test` spawns
# `auto-mobile` as a child, so it needs the same PATH.
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${BUN_BIN_DIR}" >> "${GITHUB_PATH}"
fi

# If the global install did not leave a runnable `auto-mobile`, link it onto the
# built workspace entrypoint (guaranteed to exist after `turbo run build`).
if ! command -v auto-mobile >/dev/null 2>&1; then
  if [[ -x "${DIST_ENTRY}" ]]; then
    echo "auto-mobile not resolvable from global install; linking ${BUN_BIN_DIR}/auto-mobile -> ${DIST_ENTRY}"
    mkdir -p "${BUN_BIN_DIR}"
    ln -sf "${DIST_ENTRY}" "${BUN_BIN_DIR}/auto-mobile"
    hash -r 2>/dev/null || true
  fi
fi

if ! command -v auto-mobile >/dev/null 2>&1; then
  echo "::error::auto-mobile is not on PATH and no built entrypoint at ${DIST_ENTRY}." >&2
  echo "Did 'turbo run build' and 'bun add -g .' run in setup-auto-mobile-npm-package?" >&2
  exit 1
fi
echo "auto-mobile resolved at: $(command -v auto-mobile)"

# Start the daemon (idempotent — an already-running, version-matched daemon is
# reused by the Swift test's ensureDaemonRunning()). Some CI integrations query
# debug-only or embedded-SDK-only tools after readiness, so let their workflow
# opt in before this first start rather than trying to retrofit flags onto a
# live daemon.
daemon_start_args=(--daemon start)
if [[ "${AUTOMOBILE_DAEMON_DEBUG:-}" == "1" ]]; then
  daemon_start_args+=(--debug)
fi
if [[ "${AUTOMOBILE_DAEMON_EMBEDDED_SDK:-}" == "1" ]]; then
  daemon_start_args+=(--embedded-sdk)
fi
auto-mobile "${daemon_start_args[@]}" || true

max_attempts="${DAEMON_READY_MAX_ATTEMPTS:-30}"
delay="${DAEMON_READY_DELAY_SECONDS:-1}"
attempt=1
while (( attempt <= max_attempts )); do
  # `--daemon health` exits 0 only when the daemon is running AND its socket is
  # connectable (see getDaemonHealthReport in src/daemon/manager.ts); non-zero otherwise.
  if auto-mobile --daemon health >/dev/null 2>&1; then
    echo "Daemon ready after ${attempt} attempt(s)."
    exit 0
  fi
  echo "Daemon not ready yet (attempt ${attempt}/${max_attempts}); retrying in ${delay}s..."
  sleep "${delay}"
  # Linear-capped backoff: 1s, 2s, ... up to 5s between polls.
  (( delay < 5 )) && delay=$((delay + 1))
  attempt=$((attempt + 1))
done

echo "::error::AutoMobile daemon did not become ready after ${max_attempts} attempts." >&2
auto-mobile --daemon health >&2 || true
exit 1
