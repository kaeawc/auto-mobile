import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerAppTools } from "../../src/server/appTools";
import {
  getAppPermissionsResultSchema,
  inspectPackageSigningResultSchema,
  listAppsResultSchema,
} from "../../src/server/appToolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import type { PackageSigningInspection } from "../../src/models/PackageSigningInspection";

const inspection: PackageSigningInspection = {
  appId: "com.example.app",
  platform: "android",
  deviceId: "emulator-5554",
  userId: 0,
  userSource: "explicit",
  presence: "installed",
  signing: {
    status: "available",
    scheme: "v3",
    signerSha256: ["ab"],
    signers: [{ sha256: "ab", minSdkVersion: 28 }],
  },
  observation: {
    source: "dumpsys-package+apk-signing-block",
    fresh: true,
    observedAt: "2026-10-09T00:00:00.000Z",
    scope: { deviceId: "emulator-5554", userId: 0, appId: "com.example.app" },
    apiLevel: null,
  },
};

isolateToolRegistry();

describe("app tool output schemas", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerAppTools();
  });
  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test.each([
    ["listApps", listAppsResultSchema],
    ["getAppPermissions", getAppPermissionsResultSchema],
    ["inspectPackageSigning", inspectPackageSigningResultSchema],
  ])("%s declares its outputSchema", (name, schema) => {
    expect(ToolRegistry.getTool(name)?.outputSchema).toBe(schema);
  });

  test("listApps accepts a filtered listing and rejects a payload without its message", () => {
    const payload = {
      message: "Found 1 app(s) on emulator-5554",
      query: { deviceId: "emulator-5554", type: "launchable" },
      observationComplete: true,
      totalCount: 1,
      installedCount: 3,
      deviceCount: 1,
      lastUpdated: "2026-10-09T00:00:00.000Z",
      devices: [
        {
          deviceId: "emulator-5554",
          platform: "android",
          totalCount: 1,
          lastUpdated: "2026-10-09T00:00:00.000Z",
          apps: [
            {
              packageName: "com.example.app",
              type: "user",
              foreground: false,
              recent: false,
              launchableByUserId: { 0: true },
            },
          ],
        },
      ],
      launchabilityUnknownProfiles: [10],
    };
    expect(listAppsResultSchema.safeParse(payload).success).toBe(true);
    expect(listAppsResultSchema.safeParse({ ...payload, message: undefined }).success).toBe(false);
  });

  const permissionsBase = {
    appId: "com.example.app",
    deviceId: "emulator-5554",
    platform: "android",
  };
  test.each([
    [
      "success",
      {
        ...permissionsBase,
        message: "Read 1 app permission state row(s) for com.example.app",
        success: true,
        permissions: [
          {
            permission: "android.permission.CAMERA",
            state: "granted",
            source: "androidRuntime",
          },
        ],
      },
    ],
    [
      "failure",
      {
        ...permissionsBase,
        message: "adb failed",
        success: false,
        permissions: [],
        error: "adb failed",
      },
    ],
  ])("getAppPermissions accepts a %s payload", (_label, payload) => {
    expect(getAppPermissionsResultSchema.safeParse(payload).success).toBe(true);
  });

  test("inspectPackageSigning accepts available and unavailable signing", () => {
    expect(inspectPackageSigningResultSchema.safeParse(inspection).success).toBe(true);
    expect(
      inspectPackageSigningResultSchema.safeParse({
        ...inspection,
        presence: "unknown",
        unknownReason: "dumpsys failed",
        signing: { status: "unavailable", reason: "dumpsys failed" },
      }).success,
    ).toBe(true);
    expect(
      inspectPackageSigningResultSchema.safeParse({ ...inspection, presence: "gone" }).success,
    ).toBe(false);
  });

  const device = { name: "Pixel", deviceId: "emulator-5554", platform: "android" } as const;

  test("inspectPackageSigning keeps the pre-structured text and adds a schema-valid structuredContent", async () => {
    ToolRegistry.clearTools();
    registerAppTools({
      inspectPackageSigning: {
        createInspectPackageSigning: () => ({ execute: async () => inspection }),
      },
    });
    const response = await ToolRegistry.getTool("inspectPackageSigning")!.deviceAwareHandler!(
      device,
      { appId: inspection.appId },
    );
    expect(response.content).toEqual([{ type: "text", text: JSON.stringify(inspection) }]);
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual(inspection);
    expect(inspectPackageSigningResultSchema.safeParse(response.structuredContent).success).toBe(
      true,
    );
  });

  test("inspectPackageSigning still throws a structured error when the read fails", async () => {
    ToolRegistry.clearTools();
    registerAppTools({
      inspectPackageSigning: {
        createInspectPackageSigning: () => ({
          execute: async () => {
            throw new Error("adb offline");
          },
        }),
      },
    });
    await expect(
      ToolRegistry.getTool("inspectPackageSigning")!.deviceAwareHandler!(device, {
        appId: inspection.appId,
      }),
    ).rejects.toThrow("Failed to inspect package signing");
  });

  test("listApps keeps the pre-structured text and adds a schema-valid structuredContent", async () => {
    const content = {
      query: { deviceId: device.deviceId, type: "all" as const },
      observationComplete: true,
      totalCount: 0,
      installedCount: 0,
      deviceCount: 1,
      lastUpdated: "2026-10-09T00:00:00.000Z",
      devices: [],
    };
    ToolRegistry.clearTools();
    registerAppTools({ listApps: { queryInstalledApps: async () => content } });
    const response = await ToolRegistry.getTool("listApps")!.deviceAwareHandler!(device, {});
    const expected = { message: `Found 0 app(s) on ${device.deviceId}`, ...content };
    expect(response.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual(expected);
    expect(listAppsResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });
});
