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
  APP_RESOURCE_TEMPLATES,
  APPS_RESOURCE_URIS,
  invalidateInstalledAppResourceCache,
  invalidateInstalledAppsCache,
} from "../../src/server/appResources";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeToolUtils } from "../fakes/FakeToolUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { getInstalledAppsCacheWriteCoordinator } from "../../src/db/installedAppsCacheWriteCoordinator";
import type { BootedDevice } from "../../src/models";

const resolveWithFakeTimer = async <T>(
  promise: Promise<T>,
  timer: FakeTimer,
  stepMs: number = 1,
): Promise<T> => {
  let settled = false;
  let result: T | undefined;
  let error: unknown;

  promise
    .then((value) => {
      settled = true;
      result = value;
    })
    .catch((caught) => {
      settled = true;
      error = caught;
    });

  let steps = 0;
  while (!settled) {
    if (
      timer.getPendingTimeoutCount() > 0 ||
      timer.getPendingIntervalCount() > 0 ||
      timer.getPendingSleepCount() > 0
    ) {
      timer.advanceTime(stepMs);
    }
    await new Promise((resolve) => setImmediate(resolve));
    steps += 1;
    if (steps > 100) {
      throw new Error("FakeTimer pump exceeded max steps");
    }
  }

  if (error) {
    throw error;
  }
  return result as T;
};

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

  test("registers listApps tool with a permissive schema", () => {
    const tool = ToolRegistry.getTool("listApps");
    expect(tool).toBeDefined();
    expect(() => tool!.schema.parse({})).not.toThrow();
    expect(() => tool!.schema.parse({ deviceId: "device-123" })).not.toThrow();
  });

  test("returns MCP resource guidance using a fake formatter and FakeTimer", async () => {
    const tool = ToolRegistry.getTool("listApps");
    expect(tool).toBeDefined();

    const fakeToolUtils = new FakeToolUtils();
    setListAppsToolDependencies({ toolResponseFormatter: fakeToolUtils });

    const fakeTimer = new FakeTimer();

    const result = await resolveWithFakeTimer(tool!.handler({}), fakeTimer);

    expect(fakeToolUtils.getJSONResponseCount()).toBe(1);
    const payload = fakeToolUtils.getLastJSONResponse();
    expect(payload).toEqual({
      message:
        "To list installed apps, follow this workflow:\n\n" +
        "1. Get available devices:\n" +
        "   Read resource: automobile:devices/booted\n\n" +
        "2. List apps for a specific device (using deviceId from step 1):\n" +
        "   Read resource: automobile:devices/{deviceId}/apps\n" +
        "   Or query format: automobile:apps?deviceId={deviceId}\n\n" +
        "Optional query filters:\n" +
        "  - type=user|system (default: user)\n" +
        "  - search=<term> (filter by package name)\n" +
        "  - profile=<userId> (filter by user profile)\n\n" +
        "Example: automobile:apps?deviceId=emulator-5554&type=system&search=google",
      resources: [
        "automobile:devices/booted",
        APP_RESOURCE_TEMPLATES.DEVICE_APPS,
        APPS_RESOURCE_URIS.BASE + "?deviceId={deviceId}",
      ],
      note: "All resource URIs use the 'automobile:' prefix. URIs like 'android://apps' are not supported.",
    });

    const content = result.content?.[0];
    expect(content?.type).toBe("text");
    expect(content?.text).toBeDefined();
    expect(JSON.parse(content!.text)).toEqual(payload);
  });

  test("keeps foreground resource invalidation separate from package cache dirtying", () => {
    const deviceId = "foreground-only-resource-device";

    invalidateInstalledAppResourceCache(deviceId);
    expect(getInstalledAppsCacheWriteCoordinator().isDirty(deviceId)).toBe(false);

    invalidateInstalledAppsCache(deviceId);
    expect(getInstalledAppsCacheWriteCoordinator().isDirty(deviceId)).toBe(true);
  });
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
