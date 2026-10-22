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

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../../fixtures/android-power", name), "utf8");

describe("power parsers (hand-reconstructed fixtures)", () => {
  test("a real battery reports the charger and is not faked", () => {
    expect(parseBattery(fixture("dumpsys-battery-real.txt"))).toEqual({
      level: 100,
      charging: "ac",
      status: "charging",
      faked: false,
    });
  });

  test("a faked battery is marked by UPDATES STOPPED", () => {
    expect(parseBattery(fixture("dumpsys-battery-faked-unplugged-level-15.txt"))).toEqual({
      level: 15,
      charging: "none",
      status: "discharging",
      faked: true,
    });
  });

  test("a battery dump without a level is rejected", () => {
    expect(() => parseBattery("Can't find service: battery")).toThrow("no level");
  });

  test("thermal status and override", () => {
    expect(parseThermal(fixture("dumpsys-thermalservice-normal.txt"))).toEqual({
      status: 0,
      override: false,
    });
    expect(parseThermal(fixture("dumpsys-thermalservice-override-3.txt"))).toEqual({
      status: 3,
      override: true,
    });
  });

  test("restrict background", () => {
    expect(parseRestrictBackground(fixture("netpolicy-restrict-background-enabled.txt"))).toBe(
      true,
    );
    expect(parseRestrictBackground(fixture("netpolicy-restrict-background-disabled.txt"))).toBe(
      false,
    );
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
