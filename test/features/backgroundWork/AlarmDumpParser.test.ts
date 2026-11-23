import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AospAlarmDumpParser } from "../../../src/features/backgroundWork/AlarmDumpParser";

// Captured with `adb shell dumpsys alarm` on emulators; see test/fixtures/android-alarm/README.md.
function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/android-alarm/${name}.txt`, import.meta.url), "utf8");
}

const GMS = "com.google.android.gms";
const parser = new AospAlarmDumpParser();

/** Alarm headers for `pkg`, counted without the parser: `Alarm{<hash> type N ... <pkg>}`. */
function headerCount(dump: string, pkg: string): number {
  return dump.split("\n").filter((line) => /\bAlarm\{/.test(line) && line.endsWith(` ${pkg}}`))
    .length;
}

describe("AospAlarmDumpParser", () => {
  test.each([
    ["phone-api30", "com.google.android.networkstack"],
    ["phone-api33", GMS],
    ["phone-api34", GMS],
    ["phone-api35", GMS],
    ["phone-api37", GMS],
    ["watch-api37", GMS],
    ["tv-api36", GMS],
    ["automotive-api34", GMS],
  ])(
    "%s: every alarm header of the package is parsed, with a type and trigger time",
    (device, pkg) => {
      const dump = fixture(`dumpsys-alarm-${device}`);
      const alarms = parser.parse(dump, pkg);

      expect(alarms.length).toBe(headerCount(dump, pkg));
      expect(alarms.length).toBeGreaterThan(0);
      for (const alarm of alarms) {
        expect(alarm.packageName).toBe(pkg);
        expect(alarm.alarmType).toMatch(/^(RTC|ELAPSED)(_WAKEUP)?$/);
        expect(alarm.wakeup).toBe(alarm.alarmType.endsWith("_WAKEUP"));
        expect(alarm.tag).toBeDefined();
        expect(typeof alarm.triggerInMs).toBe("number");
        expect(alarm.operation).toBeDefined();
      }
    },
  );

  test("API 30: a listener alarm reports its listener, not the null operation line before it", () => {
    expect(
      parser.parse(fixture("dumpsys-alarm-phone-api30"), "com.google.android.networkstack")[0],
    ).toEqual({
      packageName: "com.google.android.networkstack",
      alarmType: "ELAPSED_WAKEUP",
      wakeup: true,
      tag: "*walarm*:DhcpClient.wlan0.RENEW",
      triggerInMs: 43_186_926,
      windowMs: 0,
      repeatIntervalMs: 0,
      flags: 0x9,
      operation: "android.os.BinderProxy@afc3a77",
    });
  });

  test("API 34: a repeating alarm reports its window and interval", () => {
    const alarm = parser
      .parse(fixture("dumpsys-alarm-phone-api34"), "com.google.android.apps.wallpaper")
      .find((candidate) => candidate.tag?.includes("DailyLoggingAlarmReceiver"));

    expect(alarm).toMatchObject({
      alarmType: "RTC",
      wakeup: false,
      windowMs: 64_800_000,
      repeatIntervalMs: 86_400_000,
      flags: 0,
    });
  });

  test("API 34: an exact wakeup alarm carries its flags and the PendingIntent", () => {
    const heartbeat = parser
      .parse(fixture("dumpsys-alarm-phone-api34"), GMS)
      .find((alarm) => alarm.tag?.endsWith("HEARTBEAT_ALARM"));

    expect(heartbeat).toMatchObject({
      alarmType: "ELAPSED_WAKEUP",
      wakeup: true,
      flags: 0x21,
      operation:
        "PendingIntent{c3d243e: PendingIntentRecord{d07829f com.google.android.gms/com.google.android.gms.gcm broadcastIntent}}",
    });
  });

  test("falls back to nowELAPSED when the body has no relative time", () => {
    const dump = [
      "  nowELAPSED=1000",
      "    ELAPSED #0: Alarm{aa11 type 3 origWhen 4000 whenElapsed 4000 dev.example.playground}",
      "      tag=x",
    ].join("\n");
    expect(parser.parse(dump, "dev.example.playground")).toMatchObject([{ triggerInMs: 3000 }]);
  });

  test("no alarms and unrelated text yield an empty list", () => {
    expect(parser.parse(fixture("dumpsys-alarm-phone-api34"), "dev.example.absent")).toEqual([]);
    expect(parser.parse("", GMS)).toEqual([]);
  });
});
