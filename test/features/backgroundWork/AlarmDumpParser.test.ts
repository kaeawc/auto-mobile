import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AospAlarmDumpParser } from "../../../src/features/backgroundWork/AlarmDumpParser";

// Hand-reconstructed from the AOSP dump code, not device captures;
// see test/fixtures/android-alarm/README.md.
function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/android-alarm/${name}.txt`, import.meta.url), "utf8");
}

const APP = "dev.example.playground";
const parser = new AospAlarmDumpParser();

describe("AospAlarmDumpParser", () => {
  test("API 29: wakeup and repeating inexact alarms, other packages filtered", () => {
    expect(parser.parse(fixture("dumpsys-alarm-api29"), APP)).toEqual([
      {
        packageName: APP,
        alarmType: "RTC_WAKEUP",
        wakeup: true,
        tag: "*walarm*:dev.example.playground.SYNC_ALARM",
        triggerInMs: 300_000,
        windowMs: 0,
        repeatIntervalMs: 0,
        flags: 1,
        operation:
          "PendingIntent{9f8e7d6: PendingIntentRecord{5c4b3a2 dev.example.playground broadcastIntent}}",
      },
      {
        packageName: APP,
        alarmType: "ELAPSED",
        wakeup: false,
        tag: "*alarm*:dev.example.playground.CLEANUP",
        triggerInMs: 3_600_000,
        windowMs: 900_000,
        repeatIntervalMs: 86_400_000,
        flags: 0,
        operation:
          "PendingIntent{1c2d3e4: PendingIntentRecord{5f6a7b8 dev.example.playground startService}}",
      },
    ]);
  });

  test("API 34: header whenElapsed, exact flags and a listener alarm", () => {
    const alarms = parser.parse(fixture("dumpsys-alarm-api34"), APP);

    expect(alarms.map((alarm) => alarm.tag)).toEqual([
      "*walarm*:dev.example.playground.EXACT_REMINDER",
      "*alarm*:dev.example.playground.NIGHTLY_UPLOAD",
    ]);
    expect(alarms[0]).toMatchObject({
      alarmType: "ELAPSED_WAKEUP",
      wakeup: true,
      triggerInMs: 100_000,
      windowMs: 0,
      flags: 0x9,
    });
    expect(alarms[1]).toMatchObject({
      alarmType: "RTC",
      wakeup: false,
      triggerInMs: 900_000,
      windowMs: 900_000,
      repeatIntervalMs: 86_400_000,
      operation: "dev.example.playground.sched.UploadAlarmListener@a1b2c3",
    });
  });

  test("falls back to nowELAPSED when the body has no relative time", () => {
    const dump = [
      "  nowELAPSED=1000",
      "    ELAPSED #0: Alarm{aa11 type 3 origWhen 4000 whenElapsed 4000 dev.example.playground}",
      "      tag=x",
    ].join("\n");
    expect(parser.parse(dump, APP)).toMatchObject([{ triggerInMs: 3000 }]);
  });

  test("no alarms and unrelated text yield an empty list", () => {
    expect(parser.parse(fixture("dumpsys-alarm-api34"), "dev.example.absent")).toEqual([]);
    expect(parser.parse("", APP)).toEqual([]);
  });
});
