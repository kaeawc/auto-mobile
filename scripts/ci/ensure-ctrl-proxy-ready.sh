#!/usr/bin/env bash
#
# Ensure iOS CtrlProxy Ready
#
# Warms up the iOS CtrlProxy runner on the booted simulator BEFORE the bounded
# integration tests run. The daemon launches CtrlProxy lazily (via
# `xcodebuild test-without-building`) on the first `observe`; that launch can take
# far longer than a test plan's short `waitFor` window, so the first in-test
# `observe` times out (this is the `observe waitFor timed out` failure that the
# Reminders plan hit once the daemon-startup gate was fixed).
#
# Running one `observe` here — in a dedicated step with a generous window — leaves
# CtrlProxy running so the in-test `observe` is fast (~sub-second). This is the
# documented "CtrlProxy pre-installation" step
# (docs/design-docs/plat/ios/xctestrunner/ci-integration.md).
#
# `observe` exits non-zero when it cannot produce a hierarchy, so a clean exit
# means CtrlProxy is attached and serving.
#
# Usage:
#   ./scripts/ci/ensure-ctrl-proxy-ready.sh
#
# Env overrides (used by tests to keep runs fast):
#   CTRL_PROXY_READY_MAX_ATTEMPTS   max observe attempts (default 3)
#   CTRL_PROXY_READY_DELAY_SECONDS  delay between attempts, seconds (default 5)

set -uo pipefail

export PATH="${HOME}/.bun/bin:${PATH}"
hash -r 2>/dev/null || true

if ! command -v auto-mobile >/dev/null 2>&1; then
  echo "::error::auto-mobile is not on PATH; run scripts/ci/ensure-daemon-ready.sh before this step." >&2
  exit 1
fi

max_attempts="${CTRL_PROXY_READY_MAX_ATTEMPTS:-3}"
delay="${CTRL_PROXY_READY_DELAY_SECONDS:-5}"
attempt=1
while (( attempt <= max_attempts )); do
  echo "CtrlProxy warm-up ${attempt}/${max_attempts}: auto-mobile --cli observe --platform ios"
  # A clean exit means the daemon launched CtrlProxy and returned a hierarchy.
  if auto-mobile --cli observe --platform ios >/dev/null 2>&1; then
    echo "CtrlProxy ready: observe returned a hierarchy."
    exit 0
  fi
  echo "observe not ready yet; retrying in ${delay}s..."
  sleep "${delay}"
  attempt=$((attempt + 1))
done

echo "::error::iOS CtrlProxy did not become ready after ${max_attempts} observe attempts." >&2
echo "Diagnostic observe output:" >&2
auto-mobile --cli observe --platform ios >&2 || true
exit 1
