import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dozeReading,
  parseBattery,
  parseBooleanSetting,
  parseDozeEnabled,
  parseDozeState,
  parseInactive,
  parseRestrictBackground,
  parseStandbyBucket,
  parseThermal,
} from "../../../../src/features/utility/power/PowerParsers";
import { AdbPowerClient } from "../../../../src/features/utility/power/AndroidPowerClient";
import { createExecResult } from "../../../../src/utils/execResult";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../../fixtures/android-power", name), "utf8");

describe("power parsers (captured fixtures)", () => {
  test.each([
    ["phone-api30", { level: 100, charging: "ac", status: "charging", faked: false }],
    ["phone-api34", { level: 100, charging: "ac", status: "charging", faked: false }],
    ["phone-api37", { level: 100, charging: "ac", status: "charging", faked: false }],
    ["watch-api37", { level: 100, charging: "ac", status: "charging", faked: false }],
    ["automotive-api34", { level: 100, charging: "ac", status: "charging", faked: false }],
    // The TV image has no battery: present false, status unknown (1), level 0.
    ["tv-api36", { level: 0, charging: "ac", status: "unknown", faked: false }],
  ] as const)("a real battery on %s reports the charger and is not faked", (device, expected) => {
    expect(parseBattery(fixture(`dumpsys-battery-${device}.txt`))).toEqual(expected);
  });

  test("a faked battery is marked by UPDATES STOPPED", () => {
    expect(
      parseBattery(fixture("dumpsys-battery-faked-unplugged-level-15-phone-api34.txt")),
    ).toEqual({ level: 15, charging: "none", status: "discharging", faked: true });
  });

  test("a battery dump without a level is rejected", () => {
    expect(() => parseBattery("Can't find service: battery")).toThrow("no level");
  });

  test("thermal status and override", () => {
    for (const device of ["phone-api30", "phone-api34", "watch-api37", "tv-api36"]) {
      expect(parseThermal(fixture(`dumpsys-thermalservice-${device}.txt`))).toEqual({
        status: 0,
        override: false,
      });
    }
    expect(parseThermal(fixture("dumpsys-thermalservice-override-3-phone-api34.txt"))).toEqual({
      status: 3,
      override: true,
    });
  });

  test("restrict background", () => {
    expect(
      parseRestrictBackground(fixture("netpolicy-restrict-background-enabled-phone-api34.txt")),
    ).toBe(true);
    expect(
      parseRestrictBackground(fixture("netpolicy-restrict-background-disabled-phone-api34.txt")),
    ).toBe(false);
    expect(() => parseRestrictBackground("")).toThrow();
  });

  test("doze state, enabled flag and mode", () => {
    expect(parseDozeState("IDLE\n")).toBe("IDLE");
    expect(() => parseDozeState("Permission denied: 12")).toThrow();
    expect(parseDozeEnabled("1\n")).toBe(true);
    expect(parseDozeEnabled("0")).toBe(false);
    expect(dozeReading("IDLE", "ACTIVE").mode).toBe("deep");
    expect(dozeReading("ACTIVE", "IDLE").mode).toBe("light");
    expect(dozeReading("ACTIVE", "ACTIVE").mode).toBe("off");
  });

  test("boolean settings distinguish unset from off", () => {
    expect(parseBooleanSetting("1\n")).toBe(true);
    expect(parseBooleanSetting("0")).toBe(false);
    expect(parseBooleanSetting("null\n")).toBeUndefined();
  });

  test("standby buckets by number or name; inactive", () => {
    expect(parseStandbyBucket("10\n")).toBe("active");
    expect(parseStandbyBucket("45")).toBe("restricted");
    expect(parseStandbyBucket("WORKING_SET")).toBe("working_set");
    expect(parseStandbyBucket("5")).toBe("exempted");
    expect(parseStandbyBucket("garbage")).toBe("unknown");
    expect(parseInactive("Idle=true\n")).toBe(true);
    expect(parseInactive("Idle=false")).toBe(false);
  });
});

describe("deviceidle force-idle (captured fixtures)", () => {
  const clientAnswering = (stdout: string) =>
    new AdbPowerClient({
      execute: async () => createExecResult(stdout, ""),
      isScreenOn: async () => true,
    });

  test("deep idle is accepted on a phone", async () => {
    await clientAnswering(fixture("deviceidle-force-idle-deep-phone-api34.txt")).forceDoze("deep");
  });

  test("an Automotive image refuses deep idle and the refusal is reported", async () => {
    const refusal = fixture("deviceidle-force-idle-not-enabled-automotive-api34.txt");
    expect(refusal.trim()).toBe("Unable to go deep idle; not enabled");
    await expect(clientAnswering(refusal).forceDoze("deep")).rejects.toThrow("not enabled");
  });
});
