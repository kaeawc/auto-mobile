#!/usr/bin/env bash
# Verify the debug Playground's allowlisted AndroidKeyStore fixture on a rooted emulator.
set -euo pipefail

adb_bin="${ADB_BIN:-adb}"
device_id="${1:-}"
package_id="dev.jasonpearson.automobile.playground"
for required in "$adb_bin" jq; do
  if ! command -v "$required" > /dev/null 2>&1; then
    echo "error: required command not found: $required" >&2
    exit 1
  fi
done
if [[ -z "$device_id" ]]; then
  device_id="$("$adb_bin" devices | awk '$2 == "device" { print $1; exit }')"
fi
if [[ -z "$device_id" ]]; then
  echo "error: no connected Android device" >&2
  exit 1
fi

"$adb_bin" -s "$device_id" root > /dev/null
"$adb_bin" -s "$device_id" wait-for-device
"$adb_bin" -s "$device_id" shell am start -W -n "${package_id}/.MainActivity" > /dev/null
seed_result="$("$adb_bin" -s "$device_id" shell am broadcast \
  -a "${package_id}.action.TEST_SEED_KEYSTORE_FIXTURE" -p "$package_id")"
if [[ "$seed_result" != *'Broadcast completed: result=-1'* ]]; then
  echo "error: AndroidKeyStore fixture seeding failed: $seed_result" >&2
  exit 1
fi
response="$("$adb_bin" -s "$device_id" shell content call \
  --uri "content://${package_id}.automobile.keystore" \
  --method metadata --extra scope:s:fixture)"
# content call wraps the provider's JSON string in the platform Bundle display.
response="${response%$'\r'}"
prefix='Result: Bundle[{result='
suffix='}]'
if [[ "$response" != "$prefix"*"$suffix" ]]; then
  echo "error: unexpected keystore provider response" >&2
  exit 1
fi
metadata="${response#"$prefix"}"
metadata="${metadata%"$suffix"}"
if ! jq -e '
  .schemaVersion == 1 and .capability == "storage.keystore" and .outcome == "ok"
  and .bridgeAvailable == true and .metadata == "supported"
  and .mutation == "declared_unsupported" and .scopes == ["fixture"]
  and (.deviceLocked == "locked" or .deviceLocked == "unlocked" or .deviceLocked == "unknown")
  and ((keys - ["schemaVersion", "capability", "outcome", "bridgeAvailable",
    "metadata", "mutation", "deviceLocked", "scopes", "entries"]) | length == 0)
  and (.entries | length == 2)
  and (all(.entries[]; (keys == ["alias", "category", "present"]) and .present == true))
  and ((.entries | sort_by(.alias)) == [
    {alias: "automobile.fixture", present: true, category: "KEY"},
    {alias: "automobile.fixture.certificate", present: true, category: "CERTIFICATE"}
  ])
' <<< "$metadata" > /dev/null; then
  echo "error: keystore fixture metadata must contain only the two present KEY/CERTIFICATE entries and no material fields" >&2
  exit 1
fi
echo "Android keystore fixture metadata verified (KEY and CERTIFICATE; no material fields)."
