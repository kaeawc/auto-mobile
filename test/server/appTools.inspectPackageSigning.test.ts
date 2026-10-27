import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inspectPackageSigningSchema, registerAppTools } from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type {
  IosPackageSigningInspection,
  PackageSigningInspection,
} from "../../src/models/PackageSigningInspection";
import { inspectPackageSigningResultSchema } from "../../src/server/appToolOutputSchemas";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const inspection: PackageSigningInspection = {
  appId: "com.example.app",
  platform: "android",
  deviceId: "emulator-5554",
  userId: 0,
  userSource: "explicit",
  presence: "absent",
  signing: { status: "unavailable", reason: "Package is not installed" },
  observation: {
    source: "dumpsys-package+apk-signing-block",
    fresh: true,
    observedAt: "2026-10-09T00:00:00.000Z",
    scope: { deviceId: "emulator-5554", userId: 0, appId: "com.example.app" },
    apiLevel: 36,
  },
};

describe("inspectPackageSigning tool", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerAppTools();
  });
  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("is registered read-only and off by default", () => {
    const tool = ToolRegistry.getTool("inspectPackageSigning");
    expect(tool).toBeDefined();
    expect(tool?.defaultEnabled).toBe(false);
  });

  test("schema accepts appId and userId and rejects unknown fields", () => {
    expect(inspectPackageSigningSchema.safeParse({ appId: "a.b", userId: 10 }).success).toBe(true);
    expect(inspectPackageSigningSchema.safeParse({ appId: "a.b", userId: -1 }).success).toBe(false);
    expect(inspectPackageSigningSchema.safeParse({ appId: "a.b", extra: 1 }).success).toBe(false);
  });

  test("passes appId, userId and the abort signal to the inspector", async () => {
    const calls: unknown[] = [];
    ToolRegistry.clearTools();
    registerAppTools({
      inspectPackageSigning: {
        createInspectPackageSigning: () => ({
          execute: async (appId, options) => {
            calls.push({ appId, userId: options?.userId, signal: options?.signal });
            return inspection;
          },
        }),
      },
    });
    const controller = new AbortController();
    const handler = ToolRegistry.getTool("inspectPackageSigning")?.deviceAwareHandler;
    expect(handler).toBeDefined();
    const response = (await handler?.(
      { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
      { appId: "com.example.app", userId: 0 },
      undefined,
      controller.signal,
    )) as { content: Array<{ text: string }> };
    expect(calls).toEqual([{ appId: "com.example.app", userId: 0, signal: controller.signal }]);
    expect(JSON.parse(response.content[0].text).presence).toBe("absent");
  });

  test("an iOS inspection returns through the handler and matches the output schema", async () => {
    const iosInspection: IosPackageSigningInspection = {
      appId: "dev.example.app",
      platform: "ios",
      deviceId: "00008110-001A2B3C4D5E801E",
      deviceKind: "physical",
      presence: "installed",
      signing: {
        status: "available",
        cdHash: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        identifier: "dev.example.app",
        teamId: "ABCDE12345",
        signingIdentity: "Apple Development: Jane Appleseed (Q7RST8UVW9)",
        adHoc: false,
        authorities: ["Apple Development: Jane Appleseed (Q7RST8UVW9)"],
        entitlements: { "get-task-allow": true },
        provisioningProfile: {
          name: "Team Profile",
          uuid: "8F6C2B1A-3D4E-4F50-9A6B-7C8D9E0F1A2B",
          teamIds: ["ABCDE12345"],
          expirationDate: "2027-04-21T09:00:00.000Z",
          expired: false,
          provisionedDeviceCount: 2,
          provisionsAllDevices: false,
        },
      },
      observation: {
        source: "devicectl-copy+codesign",
        fresh: true,
        observedAt: "2026-10-21T10:00:00.000Z",
        scope: { deviceId: "00008110-001A2B3C4D5E801E", appId: "dev.example.app" },
      },
    };
    ToolRegistry.clearTools();
    registerAppTools({
      inspectPackageSigning: {
        createInspectPackageSigning: () => ({ execute: async () => iosInspection }),
      },
    });
    const handler = ToolRegistry.getTool("inspectPackageSigning")?.deviceAwareHandler;
    const response = (await handler?.(
      { deviceId: "00008110-001A2B3C4D5E801E", name: "iPhone", platform: "ios" },
      { appId: "dev.example.app" },
    )) as { content: Array<{ text: string }> };
    const body = JSON.parse(response.content[0].text) as unknown;
    expect(body).toEqual(iosInspection);
    expect(inspectPackageSigningResultSchema.safeParse(body).success).toBe(true);
  });

  test("the output schema still accepts the Android shape", () => {
    expect(inspectPackageSigningResultSchema.safeParse(inspection).success).toBe(true);
  });
});
