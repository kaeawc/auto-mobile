#!/usr/bin/env bash
# Cadence: cold-launch Settings, tap search, type wifi + enter, screenshot, pause 1s.
# Raw control uses the same sequence/pause; measured op durations remain in ops.log.
set -euo pipefail
# shellcheck source=scripts/ci/linux-qualification/lib.sh
source "$(dirname "$0")/lib.sh"
end=$(( $(now) + LOAD_SECONDS ))
timestamp=$(now)
while (( timestamp < end )) && [[ ! -f "$CYCLE_DIR/exit-time" ]]; do
  operation launchApp auto-mobile --cli --session-uuid "$SESSION_UUID" launchApp --platform android --appId com.android.settings --coldBoot true
  operation tapOn auto-mobile --cli --session-uuid "$SESSION_UUID" tapOn --platform android --selector '{"text":"Search settings"}'
  operation sendKeys auto-mobile --cli --session-uuid "$SESSION_UUID" sendKeys --platform android --commands '[{"action":"type","text":"wifi"},{"action":"key","key":"enter"}]'
  operation observe auto-mobile --cli --session-uuid "$SESSION_UUID" observe --platform android --screenshot settled
  pause 1
  timestamp=$(now)
done
