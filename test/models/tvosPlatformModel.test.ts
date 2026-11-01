import { describe, expect, test } from "bun:test";
import { DefaultManagedSpecMatcher } from "../../src/daemon/sessionBroker/provisioning/DefaultManagedSpecMatcher";
import { bootedSweepsFor } from "../../src/devices/bootedDiscoveryAppend";
import { bootGatePlatform } from "../../src/features/bootAdmission/sharedBootAdmissionGates";
import type { DeviceInfo } from "../../src/models";
import {
  matchesPlatformSelector,
  requireAndroidOrIosPlatform,
  requireAndroidOrIosSelector,
} from "../../src/models/Platform";
import { deleteWatchAsDaemon } from "../../src/server/deviceToolsWatchDaemonDelete";
import { sourcesForPlatform } from "../../src/utils/discoverySource";

/** An Apple TV is modelled but drives nothing yet: every platform decision fails closed (#15886). */
describe("tvOS platform model (#15886)", () => {
  test("Android/iOS-only code refuses an Apple TV, naming the operation and platform", () => {
    expect(() => requireAndroidOrIosPlatform("tvos", "Video recording")).toThrow(
      "Video recording is not supported on tvOS yet. Target an Android or iOS device instead.",
    );
    expect(() => requireAndroidOrIosSelector("tvos", "Readiness")).toThrow(
      "Readiness is not supported on tvOS yet",
    );
    expect(() => requireAndroidOrIosPlatform("watchos", "Video recording")).toThrow(
      "Video recording is not supported on watchOS yet",
    );
  });

  test("an Apple TV is reached only when asked for by name", () => {
    expect(matchesPlatformSelector("tvos", undefined)).toBe(false);
    expect(matchesPlatformSelector("tvos", "ios")).toBe(false);
    expect(matchesPlatformSelector("tvos", "tvos")).toBe(true);
  });

  test("only an explicit tvos sweep lists Apple TVs", () => {
    expect(sourcesForPlatform("tvos")).toEqual(["tvos-simulator"]);
    expect(bootedSweepsFor("tvos", {}).tvos).toBe(true);
    expect(bootedSweepsFor("either", { includeWatchOs: true }).tvos).toBe(false);
  });

  test("an Apple TV boot is admitted through the simulator gate", () => {
    expect(bootGatePlatform("tvos")).toBe("ios");
    expect(bootGatePlatform("watchos")).toBe("ios");
    expect(bootGatePlatform("android")).toBe("android");
  });

  test("a broker binding never reuses an Apple TV", async () => {
    const matcher = new DefaultManagedSpecMatcher({
      readConfig: async () => {
        throw new Error("an Apple TV is never matched through an AVD config");
      },
    });
    const appleTv: DeviceInfo = {
      name: "Apple TV 4K (3rd generation)",
      platform: "tvos",
      deviceId: "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D",
      isRunning: false,
    };
    const spec = { runtime: "com.apple.CoreSimulator.SimRuntime.tvOS-18-0" };
    expect(await matcher.matches(appleTv, spec)).toBe("mismatch");
  });

  test("the daemon watch delete refuses a non-watch target without touching it", async () => {
    const response = await deleteWatchAsDaemon({
      target: { platform: "tvos", isVirtual: true, stableId: "5B7E1C3D" },
      mode: "destroy",
      verifyAbsence: true,
    });
    expect("isError" in response && response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      success: false,
      error: "deleteWatchAsDaemon was given a tvos target, not a watch.",
    });
  });
});
