import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readToolResponse, toolIsError, toolStructured } from "../helpers/toolResponse";
import { registerAppTools } from "../../src/server/appTools";
import {
  getAppPermissionsResultSchema,
  inspectPackageSigningResultSchema,
  installAppResultSchema,
  listAppsResultSchema,
  resetKeychainResultSchema,
  setAppPermissionsResultSchema,
  uninstallAppResultSchema,
} from "../../src/server/appToolOutputSchemas";
import { advertisedOutputSchema, jsonSchemaObjects } from "../helpers/advertisedOutputSchemas";
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
    ["installApp", installAppResultSchema],
    ["uninstallApp", uninstallAppResultSchema],
    ["setAppPermissions", setAppPermissionsResultSchema],
    ["resetKeychain", resetKeychainResultSchema],
  ])("%s declares its outputSchema", (name, schema) => {
    expect(ToolRegistry.getTool(name)?.outputSchema).toBe(schema);
  });

  // A schema instance shared across fields is advertised as a `$ref` Ajv cannot resolve.
  test.each([
    ["installApp", installAppResultSchema],
    ["uninstallApp", uninstallAppResultSchema],
    ["setAppPermissions", setAppPermissionsResultSchema],
    ["resetKeychain", resetKeychainResultSchema],
  ])("%s advertises its outputSchema without a $ref", (_name, schema) => {
    const refs = jsonSchemaObjects(advertisedOutputSchema(schema, "ref")).filter(
      (node) => "$ref" in node,
    );
    expect(refs).toEqual([]);
  });

  const permissionChange = {
    appId: "com.example.app",
    deviceId: "emulator-5554",
    platform: "android",
    action: "grant",
    operations: [{ stepId: "grant-camera", success: true, changedCount: 1, failedCount: 0 }],
  };
  test.each([
    [
      "success with a diagnostic",
      {
        ...permissionChange,
        message: "Applied 1 app permission change(s) for com.example.app",
        success: true,
        changedCount: 1,
        failedCount: 0,
        diagnostics: [
          { code: "audio_input_unavailable", message: "no audio input", retryable: false },
        ],
      },
      true,
    ],
    [
      "failure",
      {
        ...permissionChange,
        message: "denied",
        success: false,
        changedCount: 0,
        failedCount: 1,
        error: "denied",
      },
      true,
    ],
    ["payload without its counts", { ...permissionChange, message: "m", success: true }, false],
  ])("setAppPermissions schema on a %s payload", (_label, payload, accepted) => {
    expect(setAppPermissionsResultSchema.safeParse(payload).success).toBe(accepted);
  });

  test("install, uninstall and resetKeychain accept only returned (successful) payloads", () => {
    const installed = {
      message: "Installed app from /tmp/app.apk",
      success: true,
      packageName: "com.example.app",
      signingGuard: { status: "matched", matchedSha256: ["ab"] },
      installRoute: "bundle",
    };
    expect(installAppResultSchema.safeParse(installed).success).toBe(true);
    expect(installAppResultSchema.safeParse({ ...installed, success: false }).success).toBe(false);
    const uninstalled = {
      message: "Uninstalled app com.example.app",
      success: true,
      packageName: "com.example.app",
      keepData: false,
      removalVerification: "absent",
    };
    expect(uninstallAppResultSchema.safeParse(uninstalled).success).toBe(true);
    expect(
      uninstallAppResultSchema.safeParse({ ...uninstalled, keepData: undefined }).success,
    ).toBe(false);
    const reset = {
      success: true,
      deviceId: "sim-1",
      platform: "ios",
      requestedAppId: "com.example.app",
      scope: "all-apps",
      exceededRequestedScope: true,
      message: "Reset",
    };
    expect(resetKeychainResultSchema.safeParse(reset).success).toBe(true);
    expect(resetKeychainResultSchema.safeParse({ ...reset, scope: "device" }).success).toBe(false);
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
    expect(readToolResponse(response).content).toEqual([
      { type: "text", text: JSON.stringify(inspection) },
    ]);
    expect(toolIsError(response)).toBe(false);
    expect(toolStructured(response)).toEqual({ ...inspection });
    expect(inspectPackageSigningResultSchema.safeParse(toolStructured(response)).success).toBe(
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
    expect(readToolResponse(response).content).toEqual([
      { type: "text", text: JSON.stringify(expected) },
    ]);
    expect(toolIsError(response)).toBe(false);
    expect(toolStructured(response)).toEqual(expected);
    expect(listAppsResultSchema.safeParse(toolStructured(response)).success).toBe(true);
  });
});
