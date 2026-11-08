import { beforeEach, describe, expect, test } from "bun:test";
import { AppPermissions } from "../../../src/features/action/AppPermissions";
import { createSetAppPermissionsHandler } from "../../../src/server/appTools";
import type { BootedDevice } from "../../../src/models";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  assertToolSupportsDevicePlatform,
  unsupportedPlatformToolMessage,
} from "../../../src/server/applePlatformToolSupport";
import { loadTvosSimctlFixture } from "../../helpers/tvosSimctlFixtures";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { toolIsError, toolStructured } from "../../helpers/toolResponse";

const TV_UDID = "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D";
const tv: BootedDevice = { name: "Apple TV 4K", deviceId: TV_UDID, platform: "tvos" };

// Bundle ID used in the capture.
const BUNDLE = "dev.jasonpearson.automobile.ctrlproxy.tv";
const GRANT_ARGV = ["privacy", TV_UDID, "grant", "photos", BUNDLE];
const RESET_ARGV = ["privacy", TV_UDID, "reset", "all", BUNDLE];
const REVOKE_ARGV = ["privacy", TV_UDID, "revoke", "photos", BUNDLE];

describe("setAppPermissions on an Apple TV simulator (#17527)", () => {
  let simctl: FakeSimctl;
  const privacyCalls = () =>
    simctl.getMethodCalls("executeCommandArgs").map((call) => call.args as string[]);

  beforeEach(() => {
    simctl = new FakeSimctl();
    for (const [name, args] of [
      ["grant", GRANT_ARGV],
      ["reset", RESET_ARGV],
      ["revoke", REVOKE_ARGV],
    ] as const) {
      const capture = loadTvosSimctlFixture(name);
      expect(capture).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      simctl.setCommandArgsResult(args, capture.stdout, capture.stderr);
    }
  });

  test("setAppPermissions is on the tvOS allowlist; getAppPermissions is not available", () => {
    expect(APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has("setAppPermissions")).toBe(true);
    expect(() => assertToolSupportsDevicePlatform("setAppPermissions", tv)).not.toThrow();
    expect(APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has("getAppPermissions")).toBe(false);
    expect(unsupportedPlatformToolMessage("getAppPermissions", "tvos")).toBe(
      "getAppPermissions is not available on tvOS: simctl cannot read app permissions on an Apple TV simulator; set them with setAppPermissions. Target an Android or iOS device instead.",
    );
  });

  test("grant runs the captured simctl privacy command and reports it unverified", async () => {
    const result = await new AppPermissions(tv, { simctl }).setPermissions(BUNDLE, {
      action: "grant",
      permissions: ["photos"],
    });

    expect(privacyCalls()).toEqual([GRANT_ARGV]);
    expect(result).toMatchObject({
      success: true,
      appId: BUNDLE,
      deviceId: TV_UDID,
      platform: "tvos",
      action: "grant",
      changedCount: 1,
      failedCount: 0,
      operations: [
        {
          stepId: "tvos_simctl_privacy:grant:photos",
          success: true,
          result: { permission: "photos", success: true, verified: false },
        },
      ],
    });
  });

  test("reset all runs the captured simctl privacy command through the tool handler", async () => {
    const handler = createSetAppPermissionsHandler(
      (device) => new AppPermissions(device, { simctl }),
    );

    const response = await handler(tv, {
      appId: BUNDLE,
      action: "reset",
      permissions: ["all"],
    });

    expect(privacyCalls()).toEqual([RESET_ARGV]);
    expect(toolStructured(response)).toMatchObject({
      success: true,
      platform: "tvos",
      message: `Applied 1 app permission change(s) for ${BUNDLE}`,
    });
    expect(toolIsError(response)).toBe(false);
  });

  test("revoke passes each service name to simctl, keeping later ones after a rejection", async () => {
    simctl.setCommandArgsError(
      ["privacy", TV_UDID, "revoke", "reminders", BUNDLE],
      new Error("Failed to revoke access: unknown service reminders"),
    );

    const result = await new AppPermissions(tv, { simctl }).setPermissions(BUNDLE, {
      action: "revoke",
      permissions: ["reminders", " photos "],
    });

    expect(privacyCalls()).toEqual([
      ["privacy", TV_UDID, "revoke", "reminders", BUNDLE],
      REVOKE_ARGV,
    ]);
    expect(result).toMatchObject({
      success: false,
      changedCount: 1,
      failedCount: 1,
      error: "Failed to revoke access: unknown service reminders",
    });
  });

  test("refuses Android-only fields by name before running simctl", async () => {
    const result = await new AppPermissions(tv, { simctl }).setPermissions(BUNDLE, {
      permissions: ["photos"],
      notificationsEnabled: true,
    });

    expect(result).toMatchObject({
      success: false,
      platform: "tvos",
      error:
        "setAppPermissions does not support the following fields on tvOS: notificationsEnabled",
    });
    expect(privacyCalls()).toEqual([]);
  });

  test("refuses a physical Apple TV before running simctl", async () => {
    const physical: BootedDevice = {
      ...tv,
      deviceId: "00008110-001A2B3C4D5E6F70",
    };

    const result = await new AppPermissions(physical, { simctl }).setPermissions(BUNDLE, {
      permissions: ["photos"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("only supported on Apple TV simulators");
    expect(privacyCalls()).toEqual([]);
  });
});
