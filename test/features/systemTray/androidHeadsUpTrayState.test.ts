import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AndroidNotificationUIDetector } from "../../../src/features/systemTray/AndroidNotificationUIDetector";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";

const fixturesDir = join(import.meta.dir, "../../fixtures/systemTray/android-37");

const load = (name: string): ViewHierarchyResult =>
  (
    JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as {
      viewHierarchy: ViewHierarchyResult;
    }
  ).viewHierarchy;

// Both captured on an API 37 emulator (#19195): a heads-up SMS over the launcher, then the
// same device after `cmd statusbar expand-notifications`.
const headsUp = load("heads-up-over-launcher-observe.json");
const expanded = load("shade-expanded-observe.json");

const device: BootedDevice = { deviceId: "emulator-5620", name: "phone", platform: "android" };
const detector = new AndroidNotificationUIDetector(device, {
  executeAdbCommand: async () => ({ stdout: "", stderr: "" }),
  getDeviceTimestampMs: async () => 0,
});

describe("AndroidNotificationUIDetector heads-up notifications (#19195)", () => {
  it("does not treat a heads-up notification over an app as an open shade", () => {
    expect(detector.isTrayOpen(headsUp)).toBe(false);
  });

  it("still detects the expanded shade", () => {
    expect(detector.isTrayOpen(expanded)).toBe(true);
  });

  it("keeps hint-only detection when the capture carries no window metadata", () => {
    expect(detector.isTrayOpen({ ...expanded, windows: undefined })).toBe(true);
  });
});
