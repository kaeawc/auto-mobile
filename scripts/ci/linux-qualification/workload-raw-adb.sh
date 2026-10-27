#!/usr/bin/env bash
# Same cadence as W: cold-launch Settings, tap search, text + enter, screenshot, 1s.
set -euo pipefail
# shellcheck source=scripts/ci/linux-qualification/lib.sh
source "$(dirname "$0")/lib.sh"
end=$(( $(now) + LOAD_SECONDS ))
timestamp=$(now)
while (( timestamp < end )) && [[ ! -f "$CYCLE_DIR/exit-time" ]]; do
  operation launch adb -s "$SERIAL" shell am start -S -W -a android.settings.SETTINGS
  operation tap adb -s "$SERIAL" shell input tap "${TAP_X:-200}" "${TAP_Y:-150}"
  operation text adb -s "$SERIAL" shell input text wifi
  operation keyevent adb -s "$SERIAL" shell input keyevent 66
  operation screencap bash -c "adb -s \"\$SERIAL\" exec-out screencap -p > /dev/null"
  pause 1
  timestamp=$(now)
done
