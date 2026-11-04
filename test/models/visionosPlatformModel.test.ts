import { describe, expect, test } from "bun:test";
import { DefaultManagedSpecMatcher } from "../../src/daemon/sessionBroker/provisioning/DefaultManagedSpecMatcher";
import { bootedSweepsFor } from "../../src/devices/bootedDiscoveryAppend";
import type { DeviceInfo } from "../../src/models";
import {
  matchesPlatformSelector,
  requireAndroidOrIosPlatform,
  requireAndroidOrIosSelector,
} from "../../src/models/Platform";
import { sourcesForPlatform } from "../../src/utils/discoverySource";

/** A Vision Pro is modelled but not discovered yet: every platform decision fails closed (#16848). */
describe("visionOS platform model (#16848)", () => {
  test("Android/iOS-only code refuses a Vision Pro, naming the operation and platform", () => {
    expect(() => requireAndroidOrIosPlatform("visionos", "Video recording")).toThrow(
      "Video recording is not supported on visionOS yet. Target an Android or iOS device instead.",
    );
    expect(() => requireAndroidOrIosSelector("visionos", "Readiness")).toThrow(
      "Readiness is not supported on visionOS yet",
    );
  });

  test("a Vision Pro is reached only when asked for by name", () => {
    expect(matchesPlatformSelector("visionos", undefined)).toBe(false);
    expect(matchesPlatformSelector("visionos", "ios")).toBe(false);
    expect(matchesPlatformSelector("visionos", "visionos")).toBe(true);
  });

  test("no sweep lists Vision Pro simulators until their inventory exists", () => {
    expect(sourcesForPlatform("visionos")).toEqual([]);
    expect(bootedSweepsFor("visionos", {}).visionos).toBe(false);
    expect(bootedSweepsFor("visionos", {}).ios).toBe(false);
    expect(bootedSweepsFor("either", { includeWatchOs: true }).visionos).toBe(false);
  });

  test("a broker binding never reuses a Vision Pro", async () => {
    const matcher = new DefaultManagedSpecMatcher({
      readConfig: async () => {
        throw new Error("a Vision Pro is never matched through an AVD config");
      },
    });
    const visionPro: DeviceInfo = {
      name: "Apple Vision Pro",
      platform: "visionos",
      deviceId: "7C1D2E3F-4A5B-4C6D-8E9F-0A1B2C3D4E5F",
      isRunning: false,
    };
    const spec = { runtime: "com.apple.CoreSimulator.SimRuntime.xrOS-26-5" };
    expect(await matcher.matches(visionPro, spec)).toBe("mismatch");
  });
});
