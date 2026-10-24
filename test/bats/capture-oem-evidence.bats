#!/usr/bin/env bats
# scripts/capture-oem-evidence.sh against a stub adb (#14048).

setup() {
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  export ADB="$BATS_TEST_TMPDIR/bin/adb"
  export DATE=2026-10-24
  export STUB_STATE=device
  cat > "$ADB" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALLS"
[ "$1" = -s ] && shift 2
if [ "$1" = get-state ]; then
  printf '%s\r\n' "$STUB_STATE"
  exit 0
fi
shift # shell
case "$*" in
  "getprop ro.product.manufacturer") printf 'samsung\r\n' ;;
  "getprop ro.product.brand") printf 'samsung\r\n' ;;
  "getprop ro.product.model") printf 'SM-S921B\r\n' ;;
  "getprop ro.product.device") printf 'e1s\r\n' ;;
  "getprop ro.build.version.release") printf '15\r\n' ;;
  "getprop ro.build.version.sdk") printf '35\r\n' ;;
  "getprop ro.build.fingerprint") printf 'samsung/e1sxeea/e1s:15/AP3A/S921B:user/release-keys\r\n' ;;
  "getprop ro.build.display.id") printf 'AP3A.S921BXXU4\r\n' ;;
  getprop)
    printf '[ro.build.version.oneui]: [70000]\r\n'
    printf '[ro.serialno]: [R5CX12345]\r\n'
    printf '[ro.boot.serialno]: [R5CX12345]\r\n'
    printf '[ril.serialnumber]: [R5CX12345]\r\n'
    printf '[persist.radio.imei]: [356938035643809]\r\n'
    printf '[ro.boot.wifimacaddr]: [aa:bb:cc:dd:ee:ff]\r\n'
    printf '[persist.bluetooth.address]: [11:22:33:44:55:66]\r\n'
    printf '[ro.product.manufacturer]: [samsung]\r\n'
    printf '[ro.machine.type]: [phone]\r\n'
    ;;
  "pm list features") printf 'feature:com.samsung.feature.samsung_experience_mobile\r\nfeature:android.hardware.camera\r\n' ;;
  "pm list packages -s") printf 'package:com.sec.android.app.launcher\r\npackage:android\r\n' ;;
  "cmd role get-role-holders android.app.role.HOME") printf 'com.sec.android.app.launcher\r\n' ;;
  "cmd role get-role-holders "*) ;;
  "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME")
    printf 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\r\ncom.sec.android.app.launcher/.activities.LauncherActivity\r\n' ;;
  "cmd package resolve-activity "*) printf 'No activity found\r\n' ;;
  "settings get secure default_input_method") printf 'com.samsung.android.honeyboard/.service.HoneyBoardService\r\n' ;;
  *) exit 1 ;;
esac
STUB
  chmod +x "$ADB"
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/capture-oem-evidence.sh"
  OUT="$BATS_TEST_TMPDIR/out"
}

@test "writes a dated per-device directory with every capture file" {
  run bash "$SCRIPT" R5CX12345 "$OUT"
  [ "$status" -eq 0 ]
  dir="$OUT/samsung-sm-s921b-20261024"
  [ "$output" = "$dir" ]
  for file in manifest.txt getprop.txt features.txt packages-system.txt default-apps.txt README.md; do
    [ -s "$dir/$file" ]
  done
  grep -Fx 'model (ro.product.model): SM-S921B' "$dir/manifest.txt"
  grep -Fx 'capture date: 2026-10-24' "$dir/manifest.txt"
  grep -Fx 'feature:com.samsung.feature.samsung_experience_mobile' "$dir/features.txt"
  run grep -l $'\r' "$dir/getprop.txt" "$dir/features.txt" "$dir/default-apps.txt"
  [ "$status" -eq 1 ]
}

@test "redacts device identifiers but keeps ordinary props" {
  run bash "$SCRIPT" R5CX12345 "$OUT"
  [ "$status" -eq 0 ]
  props="$OUT/samsung-sm-s921b-20261024/getprop.txt"
  run grep -rl -e R5CX12345 -e 356938035643809 -e 'aa:bb:cc' -e '11:22:33' "$OUT"
  [ "$status" -eq 1 ]
  grep -Fx '[ro.serialno]: [<redacted>]' "$props"
  grep -Fx '[ril.serialnumber]: [<redacted>]' "$props"
  grep -Fx '[persist.radio.imei]: [<redacted>]' "$props"
  grep -Fx '[ro.boot.wifimacaddr]: [<redacted>]' "$props"
  grep -Fx '[persist.bluetooth.address]: [<redacted>]' "$props"
  grep -Fx '[ro.machine.type]: [phone]' "$props"
  grep -Fx '[ro.product.manufacturer]: [samsung]' "$props"
}

@test "records default apps, with missing roles as <none>" {
  run bash "$SCRIPT" R5CX12345 "$OUT"
  [ "$status" -eq 0 ]
  apps="$OUT/samsung-sm-s921b-20261024/default-apps.txt"
  grep -Fx 'role HOME: com.sec.android.app.launcher' "$apps"
  grep -Fx 'role BROWSER: <none>' "$apps"
  grep -Fx 'resolve HOME: com.sec.android.app.launcher/.activities.LauncherActivity' "$apps"
  grep -Fx 'default_input_method: com.samsung.android.honeyboard/.service.HoneyBoardService' "$apps"
}

@test "lists candidate skin props in the manifest" {
  run bash "$SCRIPT" R5CX12345 "$OUT"
  [ "$status" -eq 0 ]
  grep -Fx '[ro.build.version.oneui]: [70000]' "$OUT/samsung-sm-s921b-20261024/manifest.txt"
}

@test "refuses a device that is not online, before writing anything" {
  export STUB_STATE=unauthorized
  run bash "$SCRIPT" R5CX12345 "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not an online device (state: unauthorized)"* ]]
  [ ! -e "$OUT" ]
}
