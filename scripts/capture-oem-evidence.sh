#!/usr/bin/env bash
#
# Capture the non-interactive OEM evidence #14048 asks for from one connected
# Android device: the full `getprop` dump, `pm list features`, the system
# packages, and the default home, browser, keyboard and gallery holders.
#
# Output goes to <out-dir>/<manufacturer>-<model>-<YYYYMMDD>/ with a
# manifest.txt naming the device, build and capture date. Device identifiers
# (serial numbers, IMEI/MEID, MAC and Bluetooth addresses, UUIDs) are redacted
# from the getprop dump before it is written, because these files are meant to
# be committed.
#
# The hierarchy captures (notification shade, permission dialogs, launcher pin
# confirmation) need someone to drive the device; README.md in the output
# directory lists them and the file names to save them under.
#
# Usage:
#   scripts/capture-oem-evidence.sh <serial> [out-dir]
#
# Environment:
#   ADB   adb binary to use (default: adb on PATH)
#   DATE  capture date as YYYY-MM-DD (default: today, UTC)

set -euo pipefail

SERIAL="${1:?usage: capture-oem-evidence.sh <serial> [out-dir]}"
OUT_ROOT="${2:-test/fixtures/android-oem}"
ADB="${ADB:-adb}"
CAPTURE_DATE="${DATE:-$(date -u +%Y-%m-%d)}"

if ! command -v "$ADB" >/dev/null 2>&1; then
  echo "capture-oem-evidence.sh: adb not found (set ADB or put adb on PATH)" >&2
  exit 1
fi

# An array, not a function: a function called from a `|| true` condition runs
# with `set -e` disabled, which the shell-sete gate rejects (SC2310).
ADB_SH=("$ADB" -s "$SERIAL" shell)

state="$("$ADB" -s "$SERIAL" get-state 2>/dev/null | tr -d '\r' || true)"
if [ "$state" != "device" ]; then
  echo "capture-oem-evidence.sh: $SERIAL is not an online device (state: ${state:-missing})" >&2
  exit 1
fi

prop() {
  "${ADB_SH[@]}" getprop "$1" | tr -d '\r'
}

slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//'
}

MANUFACTURER="$(prop ro.product.manufacturer)"
BRAND="$(prop ro.product.brand)"
MODEL="$(prop ro.product.model)"
DEVICE="$(prop ro.product.device)"
RELEASE="$(prop ro.build.version.release)"
SDK_INT="$(prop ro.build.version.sdk)"
FINGERPRINT="$(prop ro.build.fingerprint)"
DISPLAY_ID="$(prop ro.build.display.id)"

OUT_DIR="$OUT_ROOT/$(slug "$MANUFACTURER")-$(slug "$MODEL")-${CAPTURE_DATE//-/}"
mkdir -p "$OUT_DIR"

# getprop lines look like `[key]: [value]`. A key is redacted when any of its
# dot/underscore/dash-separated parts names a device identifier: a serial,
# IMEI/MEID/ICCID/IMSI, phone number, UUID, or a MAC/Bluetooth address
# (`wifimacaddr`, `bt.mac`, `bluetooth.address`). Matching is on whole parts so
# `ro.machine.type` survives.
"${ADB_SH[@]}" getprop | tr -d '\r' | awk '
  BEGIN {
    split("did cpuid ssid", ids, " ")
    for (i in ids) identifier[ids[i]] = 1
  }
  {
    key = $0
    sub(/^\[/, "", key)
    sub(/\].*$/, "", key)
    n = split(tolower(key), parts, /[._-]/)
    redact = 0
    for (i = 1; i <= n; i++) {
      if ((parts[i] in identifier) || parts[i] ~ /serial|imei|meid|iccid|imsi|msisdn|uuid|mac$|macaddr|addr$|address$/) redact = 1
    }
    if (redact) print "[" key "]: [<redacted>]"
    else print
  }
' >"$OUT_DIR/getprop.txt"

"${ADB_SH[@]}" pm list features | tr -d '\r' | sort >"$OUT_DIR/features.txt"
"${ADB_SH[@]}" pm list packages -s | tr -d '\r' | sort >"$OUT_DIR/packages-system.txt"

# Default apps. `cmd role` exists from API 29; a missing role prints nothing.
# Best effort: one unanswered query must not lose the rest of the capture.
{
  for role in HOME BROWSER DIALER SMS ASSISTANT; do
    holders="$("${ADB_SH[@]}" cmd role get-role-holders "android.app.role.$role" 2>/dev/null | tr -d '\r' || true)"
    printf 'role %s: %s\n' "$role" "${holders:-<none>}"
  done
  home="$("${ADB_SH[@]}" cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tr -d '\r' | tail -n 1 || true)"
  printf 'resolve HOME: %s\n' "${home:-<none>}"
  gallery="$("${ADB_SH[@]}" cmd package resolve-activity --brief -a android.intent.action.VIEW -t 'image/*' 2>/dev/null | tr -d '\r' | tail -n 1 || true)"
  printf 'resolve VIEW image/*: %s\n' "${gallery:-<none>}"
  keyboard="$("${ADB_SH[@]}" settings get secure default_input_method 2>/dev/null | tr -d '\r' || true)"
  printf 'default_input_method: %s\n' "${keyboard:-<none>}"
} >"$OUT_DIR/default-apps.txt"

{
  echo "# OEM evidence capture (#14048). Captured by scripts/capture-oem-evidence.sh; do not hand-edit."
  echo "capture date: $CAPTURE_DATE"
  echo "manufacturer (ro.product.manufacturer): $MANUFACTURER"
  echo "brand (ro.product.brand): $BRAND"
  echo "model (ro.product.model): $MODEL"
  echo "device (ro.product.device): $DEVICE"
  echo "android release (ro.build.version.release): $RELEASE"
  echo "api level (ro.build.version.sdk): $SDK_INT"
  echo "build display id (ro.build.display.id): $DISPLAY_ID"
  echo "build fingerprint (ro.build.fingerprint): $FINGERPRINT"
  echo "#"
  echo "# Candidate skin-version props: names that mention an OEM skin. Unconfirmed until"
  echo "# a person checks them against the skin version shown in the device's Settings."
  grep -i -E '^\[[^]]*(oneui|sem|miui|hyperos|mi\.os|coloros|oplus|oppo|oxygen|oneplus|moto|samsung)[^]]*\]' \
    "$OUT_DIR/getprop.txt" || echo "(none found)"
} >"$OUT_DIR/manifest.txt"

cat >"$OUT_DIR/README.md" <<EOF
# OEM evidence: $MANUFACTURER $MODEL ($CAPTURE_DATE)

Captured for #14048 by \`scripts/capture-oem-evidence.sh\`. Android $RELEASE (API $SDK_INT).

| File | Contents |
| --- | --- |
| \`manifest.txt\` | Device, build, capture date and candidate skin-version props |
| \`getprop.txt\` | Full \`getprop\` dump with device identifiers redacted |
| \`features.txt\` | \`pm list features\` |
| \`packages-system.txt\` | \`pm list packages -s\` |
| \`default-apps.txt\` | Role holders, resolved HOME and image viewer, default keyboard |

## Still to capture by hand

Save each as an \`observe\` result in this directory:

- [ ] \`shade-collapsed-group.json\`: notification shade with a collapsed group of 2+ notifications
- [ ] \`shade-expanded-group.json\`: the same group expanded
- [ ] \`permission-runtime.json\`: a runtime permission dialog (e.g. camera)
- [ ] \`permission-notifications.json\`: the notification-permission dialog
- [ ] \`launcher-pin-confirmation.json\`: the launcher pin-shortcut confirmation (#12266)
- [ ] Reference only: screenshots of the OEM battery and app-management screens
EOF

echo "$OUT_DIR"
