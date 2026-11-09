#!/usr/bin/env bash
# Grant the emulator-only content seeder its SMS role and runtime permissions.
# There is no calendar role: calendar writes use READ_CALENDAR/WRITE_CALENDAR,
# an AccountManager account, and CALLER_IS_SYNCADAPTER=true with account URI params.
# Usage: ANDROID_SERIAL=emulator-5554 grant-content-seeder-roles.sh
#    or: grant-content-seeder-roles.sh --serial emulator-5554
# Install the debug/test-only APK with adb install -t before running this script.
set -euo pipefail

serial="${ANDROID_SERIAL:-}"
if [[ "${1:-}" == "--serial" && $# -eq 2 && -n "${2:-}" ]]; then
  serial="$2"
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--serial <adb-serial>] (or set ANDROID_SERIAL)" >&2
  exit 2
fi
if [[ -z "$serial" ]]; then
  echo "Set ANDROID_SERIAL or pass --serial <adb-serial>" >&2
  exit 2
fi

package="dev.jasonpearson.automobile.contentseeder"
adb -s "$serial" shell cmd role add-role-holder --user 0 android.app.role.SMS "$package"
for permission in READ_CALENDAR WRITE_CALENDAR READ_SMS; do
  adb -s "$serial" shell pm grant --user 0 "$package" "android.permission.$permission"
done
adb -s "$serial" shell cmd role get-role-holders --user 0 android.app.role.SMS
