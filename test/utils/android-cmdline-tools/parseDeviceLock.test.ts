import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeviceLock } from "../../../src/utils/android-cmdline-tools/parseDeviceLock";

// Raw `dumpsys window policy` captures (API 36 emulators, issue #10182); see the fixture README.
const capture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-window-policy", name), "utf8");

describe("parseDeviceLock over captured dumps", () => {
  it.each([
    "dumpsys-window-policy-unlocked-emulator-5600.txt",
    "dumpsys-window-policy-unlocked-emulator-5602.txt",
    "dumpsys-window-policy-asleep-nokeyguard-emulator-5600.txt",
    "dumpsys-window-policy-asleep-nokeyguard-emulator-5602.txt",
    "dumpsys-window-policy-after-wake-nokeyguard-emulator-5600.txt",
    "dumpsys-window-policy-after-wake-nokeyguard-emulator-5602.txt",
  ])("%s is not locked", (name) => {
    expect(parseDeviceLock(capture(name))).toEqual({
      locked: false,
      keyguardShowing: false,
      secure: false,
    });
  });

  it("reports a showing swipe keyguard as locked and not secure", () => {
    expect(
      parseDeviceLock(capture("dumpsys-window-policy-swipe-keyguard-showing-emulator-5602.txt")),
    ).toEqual({ locked: true, keyguardShowing: true, secure: false });
  });

  it("returns null when the keyguard block is absent", () => {
    expect(parseDeviceLock("")).toBeNull();
  });
});
