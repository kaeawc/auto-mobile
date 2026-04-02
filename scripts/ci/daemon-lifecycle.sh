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

bun dist/src/index.js --daemon start  2>&1 | tee ci-logs/daemon-start.log
bun dist/src/index.js --daemon health 2>&1 | tee ci-logs/daemon-health.log

# Doctor exits non-zero when checks fail (expected on CI without devices).
# We just verify the daemon responds to the request.
bun dist/src/index.js --cli doctor --json 2>&1 | tee ci-logs/daemon-doctor.log || true

bun dist/src/index.js --daemon stop   2>&1 | tee ci-logs/daemon-stop.log
