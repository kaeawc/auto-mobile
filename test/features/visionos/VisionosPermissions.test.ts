import { beforeEach, describe, expect, test } from "bun:test";
import { AppPermissions } from "../../../src/features/action/AppPermissions";
import { createSetAppPermissionsHandler } from "../../../src/server/appTools";
import { setAppPermissionsResultSchema } from "../../../src/server/appToolOutputSchemas";
import type { BootedDevice } from "../../../src/models";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  assertRequestedPlatformSupported,
  assertToolSupportsDevicePlatform,
} from "../../../src/server/applePlatformToolSupport";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { toolIsError, toolStructured } from "../../helpers/toolResponse";

const VISION_UDID = "7C2D9E4F-3B5A-4F7C-9D0E-2F3A4B5C6D7E";
const visionPro: BootedDevice = {
  name: "Apple Vision Pro",
  deviceId: VISION_UDID,
  platform: "visionos",
};
const BUNDLE = "com.example.spatial";
const GRANT_ARGV = ["privacy", VISION_UDID, "grant", "photos", BUNDLE];
const RESET_ARGV = ["privacy", VISION_UDID, "reset", "all", BUNDLE];

// visionOS takes the tvOS simctl privacy path (#19186). No visionOS capture exists yet, so the fake
// answers as the captured tvOS commands did: exit 0 with no output.
describe("setAppPermissions on an Apple Vision Pro simulator (#19186)", () => {
  let simctl: FakeSimctl;
  const privacyCalls = () =>
    simctl.getMethodCalls("executeCommandArgs").map((call) => call.args as string[]);

  beforeEach(() => {
    simctl = new FakeSimctl();
    simctl.setCommandArgsResult(GRANT_ARGV, "", "");
    simctl.setCommandArgsResult(RESET_ARGV, "", "");
  });

  test("setAppPermissions is on the visionOS allowlist and passes both platform gates", () => {
    expect(APPLE_PLATFORM_SUPPORTED_TOOLS.visionos.has("setAppPermissions")).toBe(true);
    expect(() => assertToolSupportsDevicePlatform("setAppPermissions", visionPro)).not.toThrow();
    expect(() =>
      assertRequestedPlatformSupported("setAppPermissions", { platform: "visionos" }),
    ).not.toThrow();
    expect(APPLE_PLATFORM_SUPPORTED_TOOLS.visionos.has("getAppPermissions")).toBe(false);
  });

  test("grant runs simctl privacy and reports the change unverified", async () => {
    const result = await new AppPermissions(visionPro, { simctl }).setPermissions(BUNDLE, {
      action: "grant",
      permissions: ["photos"],
    });

    expect(privacyCalls()).toEqual([GRANT_ARGV]);
    expect(result).toMatchObject({
      success: true,
      appId: BUNDLE,
      deviceId: VISION_UDID,
      platform: "visionos",
      action: "grant",
      changedCount: 1,
      failedCount: 0,
      operations: [
        {
          stepId: "visionos_simctl_privacy:grant:photos",
          success: true,
          result: { permission: "photos", success: true, verified: false },
        },
      ],
      appTerminated: true,
    });
  });

  test("reset all through the tool handler matches the output schema", async () => {
    const handler = createSetAppPermissionsHandler(
      (device) => new AppPermissions(device, { simctl }),
    );

    const response = await handler(visionPro, {
      appId: BUNDLE,
      action: "reset",
      permissions: ["all"],
    });

    expect(privacyCalls()).toEqual([RESET_ARGV]);
    expect(toolStructured(response)).toMatchObject({
      success: true,
      platform: "visionos",
      appTerminated: true,
    });
    expect(toolIsError(response)).toBe(false);
    expect(setAppPermissionsResultSchema.safeParse(toolStructured(response)).success).toBe(true);
  });

  test("a rejected service fails without reporting the app terminated", async () => {
    simctl.setCommandArgsError(GRANT_ARGV, new Error("Failed to grant access"));

    const result = await new AppPermissions(visionPro, { simctl }).setPermissions(BUNDLE, {
      action: "grant",
      permissions: ["photos"],
    });

    expect(result).toMatchObject({
      success: false,
      platform: "visionos",
      changedCount: 0,
      failedCount: 1,
      error: "Failed to grant access",
    });
    expect(result.appTerminated).toBeUndefined();
  });

  test("refuses Android-only fields by name before running simctl", async () => {
    const result = await new AppPermissions(visionPro, { simctl }).setPermissions(BUNDLE, {
      permissions: ["photos"],
      scheduleExactAlarm: "allow",
    });

    expect(result).toMatchObject({
      success: false,
      platform: "visionos",
      error:
        "setAppPermissions does not support the following fields on visionOS: scheduleExactAlarm",
    });
    expect(privacyCalls()).toEqual([]);
  });

  test("refuses a physical Apple Vision Pro before running simctl", async () => {
    const physical: BootedDevice = { ...visionPro, deviceId: "00008112-001A2B3C4D5E6F70" };

    const result = await new AppPermissions(physical, { simctl }).setPermissions(BUNDLE, {
      permissions: ["photos"],
    });

    expect(result).toMatchObject({
      success: false,
      platform: "visionos",
      error:
        "visionOS permission changes use simctl privacy and are only supported on Apple Vision Pro simulators",
    });
    expect(privacyCalls()).toEqual([]);
  });
});
