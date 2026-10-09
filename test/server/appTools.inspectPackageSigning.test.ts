import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  inspectPackageSigningSchema,
  registerAppTools,
  resetInspectPackageSigningToolDependencies,
  setInspectPackageSigningToolDependencies,
} from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { PackageSigningInspection } from "../../src/models/PackageSigningInspection";

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
    resetInspectPackageSigningToolDependencies();
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
    setInspectPackageSigningToolDependencies({
      createInspectPackageSigning: () => ({
        execute: async (appId, options) => {
          calls.push({ appId, userId: options?.userId, signal: options?.signal });
          return inspection;
        },
      }),
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
});
