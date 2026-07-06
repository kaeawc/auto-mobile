#!/usr/bin/env bash
#
# Warm the iOS Reminders target app before the timed XCTestRunner plan.
#
# CtrlProxy warm-up proves hierarchy extraction is serving, but the first target-app
# launch can still pay app bring-up cost inside a short plan waitFor window. Launch
# Reminders and take one plain observation here so the real plan starts with the
# app foregrounded and the first timed observe is not also the first app bring-up.

set -euo pipefail

export PATH="${HOME}/.bun/bin:${PATH}"
hash -r 2>/dev/null || true

if ! command -v auto-mobile >/dev/null 2>&1; then
  echo "::error::auto-mobile is not on PATH; run scripts/ci/ensure-daemon-ready.sh before this step." >&2
  exit 1
fi

app_id="${REMINDERS_TARGET_APP_ID:-com.apple.reminders}"
max_attempts="${REMINDERS_TARGET_READY_MAX_ATTEMPTS:-3}"
delay="${REMINDERS_TARGET_READY_DELAY_SECONDS:-5}"

attempt=1
while (( attempt <= max_attempts )); do
  echo "Reminders warm-up ${attempt}/${max_attempts}: launch ${app_id} and observe"
  if auto-mobile --cli launchApp --platform ios --appId "${app_id}" >/dev/null 2>&1 &&
     auto-mobile --cli observe --platform ios >/dev/null 2>&1; then
    echo "Reminders target app ready: launchApp and observe completed."
    exit 0
  fi
  echo "Reminders target app not ready yet; retrying in ${delay}s..."
  sleep "${delay}"
  attempt=$((attempt + 1))
done

echo "::error::Reminders target app did not become ready after ${max_attempts} attempts." >&2
echo "Diagnostic launch output:" >&2
auto-mobile --cli launchApp --platform ios --appId "${app_id}" >&2 || true
echo "Diagnostic observe output:" >&2
auto-mobile --cli observe --platform ios >&2 || true
exit 1
