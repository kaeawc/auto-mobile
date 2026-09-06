import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  crashAppResultSchema,
  registerAppTools,
  resetCrashAppToolDependencies,
  resetListAppsToolDependencies,
  resetTerminateAppToolDependencies,
  setCrashAppToolDependencies,
  setListAppsToolDependencies,
  setTerminateAppToolDependencies,
} from "../../src/server/appTools";
import {
  invalidateInstalledAppResourceCache,
  invalidateInstalledAppsCache,
  type AppsQueryOptions,
  type AppsQueryResourceContent,
} from "../../src/server/appResources";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeToolUtils } from "../fakes/FakeToolUtils";
import { getInstalledAppsCacheWriteCoordinator } from "../../src/db/installedAppsCacheWriteCoordinator";
import type { BootedDevice } from "../../src/models";

function fakeAppsContent(
  overrides: Partial<AppsQueryResourceContent> = {},
): AppsQueryResourceContent {
  return {
    query: { deviceId: "emulator-5554", type: "user" },
    observationComplete: true,
    totalCount: 0,
    deviceCount: 1,
    lastUpdated: new Date(0).toISOString(),
    devices: [],
    ...overrides,
  };
}

describe("listApps tool", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    resetListAppsToolDependencies();
    resetTerminateAppToolDependencies();
    registerAppTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetListAppsToolDependencies();
    resetTerminateAppToolDependencies();
  });

  const device: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 8",
    platform: "android",
  };

  test("registers listApps as a device-aware tool accepting type/search/profile", () => {
    const tool = ToolRegistry.getTool("listApps");
    expect(tool).toBeDefined();
    expect(tool?.requiresDevice).toBe(true);
    expect(tool?.deviceAwareHandler).toBeDefined();
    expect(() => tool!.schema.parse({})).not.toThrow();
    expect(() => tool!.schema.parse({ deviceId: "device-123" })).not.toThrow();
    expect(() => tool!.schema.parse({ type: "system", search: "clock", profile: 0 })).not.toThrow();
    expect(() => tool!.schema.parse({ type: "bogus" })).toThrow();
  });

  test("the device-targeting param the docs advertise (device) is actually accepted, and actually advertised (#6216 review)", () => {
    const tool = ToolRegistry.getTool("listApps");
    expect(tool).toBeDefined();
    expect(() => tool!.schema.parse({ device: "Pixel 8" })).not.toThrow();

    const definition = ToolRegistry.getToolDefinitions({ includeUnavailable: true }).find(
      (candidate) => candidate.name === "listApps",
    );
    const properties = definition!.inputSchema.properties as Record<string, unknown>;
    // deviceId is deliberately stripped from the advertised schema for every
    // device-aware tool (see isInjectedDeviceIdSchema) — docs must not promise
    // it. `device` (the device label) is the field MCP clients actually see.
    expect(properties.device).toBeDefined();
    expect(properties.deviceId).toBeUndefined();
  });

  test("returns structured app data (not prose) for the resolved device", async () => {
    const tool = ToolRegistry.getTool("listApps");
    expect(tool).toBeDefined();

    const fakeToolUtils = new FakeToolUtils();
    let capturedOptions: AppsQueryOptions | undefined;
    const fakeContent = fakeAppsContent({
      totalCount: 1,
      devices: [
        {
          deviceId: device.deviceId,
          platform: device.platform,
          totalCount: 1,
          lastUpdated: new Date(0).toISOString(),
          apps: [
            { packageName: "com.example.app", type: "user", foreground: false, recent: false },
          ],
        },
      ],
    });
    setListAppsToolDependencies({
      toolResponseFormatter: fakeToolUtils,
      queryInstalledApps: async (options) => {
        capturedOptions = options;
        return fakeContent;
      },
    });

    const result = await tool!.deviceAwareHandler!(device, {});

    expect(capturedOptions).toEqual({
      deviceId: device.deviceId,
      platform: device.platform,
      type: undefined,
      search: undefined,
      profile: undefined,
    });

    expect(fakeToolUtils.getJSONResponseCount()).toBe(1);
    const payload = fakeToolUtils.getLastJSONResponse();
    expect(typeof payload.message).toBe("string");
    expect(payload.devices).toEqual(fakeContent.devices);
    expect(payload.totalCount).toBe(1);

    const content = result.content?.[0];
    expect(content?.type).toBe("text");
    expect(JSON.parse(content!.text)).toEqual(payload);
  });

  test("passes an explicit type filter through to the query", async () => {
    const tool = ToolRegistry.getTool("listApps");
    const fakeToolUtils = new FakeToolUtils();
    let capturedOptions: AppsQueryOptions | undefined;
    setListAppsToolDependencies({
      toolResponseFormatter: fakeToolUtils,
      queryInstalledApps: async (options) => {
        capturedOptions = options;
        return fakeAppsContent({ query: options });
      },
    });

    await tool!.deviceAwareHandler!(device, { type: "all", search: "clock", profile: 0 });

    expect(capturedOptions?.type).toBe("all");
    expect(capturedOptions?.search).toBe("clock");
    expect(capturedOptions?.profile).toBe(0);
  });

  test("wraps a query failure as an ActionableError", async () => {
    const tool = ToolRegistry.getTool("listApps");
    setListAppsToolDependencies({
      queryInstalledApps: async () => {
        throw new Error("device not found");
      },
    });

    await expect(tool!.deviceAwareHandler!(device, {})).rejects.toThrow(
      `Failed to list apps for device ${device.deviceId}`,
    );
  });

  test("keeps foreground resource invalidation separate from package cache dirtying", () => {
    const deviceId = "foreground-only-resource-device";

    invalidateInstalledAppResourceCache(deviceId);
    expect(getInstalledAppsCacheWriteCoordinator().isDirty(deviceId)).toBe(false);

    invalidateInstalledAppsCache(deviceId);
    expect(getInstalledAppsCacheWriteCoordinator().isDirty(deviceId)).toBe(true);
  });
});

test("listApps only requires booted-device readiness, not full CtrlProxy automation setup (#6216 review)", () => {
  // Mirrors the interception pattern in videoRecordingReadiness.test.ts: capture
  // the options object passed to registerDeviceAware without driving the real
  // resolveExecutionTarget/DeviceSessionManager pipeline.
  ToolRegistry.clearTools();
  const registry = ToolRegistry as any;
  const originalRegister = registry.registerDeviceAware;
  let capturedReadiness: unknown;

  registry.registerDeviceAware = (
    name: string,
    _description: string,
    _schema: unknown,
    _handler: unknown,
    options: any,
  ) => {
    if (name === "listApps") {
      capturedReadiness = options?.deviceReadiness;
    }
  };

  try {
    registerAppTools();
  } finally {
    registry.registerDeviceAware = originalRegister;
    ToolRegistry.clearTools();
  }

  expect(capturedReadiness).toBe("booted");
});

describe("terminateApp tool", () => {
  const device: BootedDevice = {
    deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    name: "iPhone 15",
    platform: "ios",
  };

  beforeEach(() => {
    ToolRegistry.clearTools();
    resetListAppsToolDependencies();
    resetTerminateAppToolDependencies();
    registerAppTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetListAppsToolDependencies();
    resetTerminateAppToolDependencies();
  });

  test("surfaces a typed TerminateApp failure instead of reporting success", async () => {
    setTerminateAppToolDependencies({
      createTerminateApp: () => ({
        execute: async () => ({
          success: false,
          packageName: "com.example.app",
          wasForeground: false,
          error: "The installed-app listing failed",
        }),
      }),
    });
    const tool = ToolRegistry.getTool("terminateApp");

    expect(tool?.deviceAwareHandler).toBeDefined();
    await expect(tool!.deviceAwareHandler!(device, { appId: "com.example.app" })).rejects.toThrow(
      "The installed-app listing failed",
    );
  });
});

describe("crashApp tool", () => {
  const device: BootedDevice = {
    deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    name: "iPhone 15",
    platform: "ios",
  };

  beforeEach(() => {
    ToolRegistry.clearTools();
    resetCrashAppToolDependencies();
    registerAppTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetCrashAppToolDependencies();
  });

  test("returns an explicit unsupported result as structured JSON", async () => {
    setCrashAppToolDependencies({
      createCrashApp: () => ({
        execute: async () => ({
          success: false,
          supported: false,
          platform: "ios",
          appId: "com.example.app",
          mechanism: "unsupported",
          timestamp: 1234,
          confirmed: false,
          error: "Physical iOS devices are unsupported",
        }),
      }),
    });
    const tool = ToolRegistry.getTool("crashApp");

    const response = await tool!.deviceAwareHandler!(device, {
      appId: "com.example.app",
    });
    const payload = JSON.parse(response.content[0].text);

    expect(response.structuredContent).toEqual(payload);
    expect(crashAppResultSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(payload).toMatchObject({
      message: "Physical iOS devices are unsupported",
      success: false,
      supported: false,
      confirmed: false,
    });
  });

  test("reports the mechanism and OS confirmation on success", async () => {
    setCrashAppToolDependencies({
      createCrashApp: () => ({
        execute: async () => ({
          success: true,
          supported: true,
          platform: "ios",
          appId: "com.example.app",
          processId: 42,
          mechanism: "ios_simulator_sigabrt",
          timestamp: 1234,
          wasRunning: true,
          confirmed: true,
        }),
      }),
    });
    const tool = ToolRegistry.getTool("crashApp");

    const response = await tool!.deviceAwareHandler!(device, {
      appId: "com.example.app",
    });
    const payload = JSON.parse(response.content[0].text);

    expect(response.structuredContent).toEqual(payload);
    expect(crashAppResultSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(payload.message).toContain("ios_simulator_sigabrt");
    expect(payload.message).toContain("OS crash confirmed");
    expect(payload.confirmed).toBe(true);
  });

  test("invalidates cached app resources when cancellation follows crash dispatch", async () => {
    const controller = new AbortController();
    let invalidations = 0;
    let notifications = 0;
    setCrashAppToolDependencies({
      createCrashApp: () => ({
        execute: async () => {
          controller.abort();
          controller.signal.throwIfAborted();
          throw new Error("unreachable");
        },
      }),
      invalidateAppResourceCache: () => invalidations++,
      notifyAppResourceUpdated: async () => {
        notifications++;
      },
    });
    const tool = ToolRegistry.getTool("crashApp");

    await expect(
      tool!.deviceAwareHandler!(device, { appId: "com.example.app" }, undefined, controller.signal),
    ).rejects.toThrow();

    expect(invalidations).toBe(1);
    expect(notifications).toBe(0);
  });
});

describe("app permission tools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    resetListAppsToolDependencies();
    registerAppTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetListAppsToolDependencies();
  });

  test("registers cross-platform set/query permission tools", () => {
    const setAppTool = ToolRegistry.getTool("setAppPermissions");
    const getAppTool = ToolRegistry.getTool("getAppPermissions");

    expect(setAppTool).toBeDefined();
    expect(setAppTool?.requiresDevice).toBe(true);
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        permissions: ["camera"],
        action: "grant",
      }),
    ).not.toThrow();
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        permissions: [],
      }),
    ).toThrow();
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        notificationPolicyAccess: true,
        scheduleExactAlarm: "allow",
      }),
    ).not.toThrow();
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        notificationsEnabled: false,
      }),
    ).not.toThrow();
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        permissions: ["android.permission.POST_NOTIFICATIONS"],
        userId: 10,
      }),
    ).not.toThrow();
    expect(
      setAppTool!.schema.parse({
        appId: " com.example.app ",
        notificationsEnabled: false,
      }).appId,
    ).toBe("com.example.app");
    expect(() =>
      setAppTool!.schema.parse({
        appId: " ",
        notificationsEnabled: false,
      }),
    ).toThrow();
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        action: "reset",
        permissions: ["all"],
        userId: 10,
      }),
    ).toThrow();
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        action: "reset",
        notificationsEnabled: false,
      }),
    ).toThrow();
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        action: "reset",
        permissions: [],
      }),
    ).toThrow();
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        action: "reset",
        permissions: ["camera"],
        platform: "android",
      }),
    ).toThrow();
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        action: "reset",
        permissions: [" all "],
        platform: "android",
      }),
    ).toThrow();
    expect(() =>
      setAppTool!.schema.parse({
        appId: "com.example.app",
        action: "reset",
        permissions: ["camera"],
        platform: "ios",
      }),
    ).not.toThrow();
    expect(setAppTool?.description).toContain("POST_NOTIFICATIONS");

    expect(getAppTool).toBeDefined();
    expect(getAppTool?.requiresDevice).toBe(true);
    expect(() =>
      getAppTool!.schema.parse({
        appId: "com.example.app",
        permissions: ["camera"],
      }),
    ).not.toThrow();
    expect(() =>
      getAppTool!.schema.parse({
        appId: "com.example.app",
      }),
    ).not.toThrow();
  });

  test("does not register platform-named permission tools", () => {
    expect(ToolRegistry.getTool("grantAndroidPermissions")).toBeUndefined();
    expect(ToolRegistry.getTool("setAndroidNotificationPolicyAccess")).toBeUndefined();
    expect(ToolRegistry.getTool("setAndroidScheduleExactAlarmAppOp")).toBeUndefined();
    expect(ToolRegistry.getTool("grantIosSimulatorPermissions")).toBeUndefined();
    expect(ToolRegistry.getTool("setIosSimulatorPermissions")).toBeUndefined();
    expect(ToolRegistry.getTool("getIosSimulatorPermissions")).toBeUndefined();
  });

  test("advertises Android permission action scope", () => {
    const setAppPermissions = ToolRegistry.getToolDefinitions({ includeUnavailable: true }).find(
      (tool) => tool.name === "setAppPermissions",
    );
    const validate = new Ajv2020({ strict: false }).compile(setAppPermissions!.inputSchema);

    expect(
      validate({
        appId: "com.example.app",
        action: "reset",
        permissions: ["all"],
      }),
    ).toBe(true);
    expect(
      validate({
        appId: "com.example.app",
        action: "reset",
        permissions: ["all"],
        userId: 10,
      }),
    ).toBe(false);
    expect(
      validate({
        appId: "com.example.app",
        action: "reset",
        notificationsEnabled: false,
      }),
    ).toBe(false);
    expect(
      validate({
        appId: "com.example.app",
        action: "reset",
        permissions: ["camera"],
        platform: "android",
      }),
    ).toBe(false);
    expect(
      validate({
        appId: "com.example.app",
        action: "reset",
        permissions: [],
        platform: "android",
      }),
    ).toBe(false);
    expect(
      validate({
        appId: "com.example.app",
        action: "reset",
        permissions: ["camera"],
        platform: "ios",
      }),
    ).toBe(true);
    expect(setAppPermissions!.description).toContain("userId grant/revoke");
    expect(setAppPermissions.description).toContain("device-wide reset ['all']");
    expect(setAppPermissions.description).toContain("no POST_NOTIFICATIONS");
  });
});
