import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deviceResourceConfigurationSchema,
  setDeviceResourcesSchema,
} from "../../src/server/deviceResourceSchemas";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceResourceController } from "../fakes/FakeDeviceResourceController";
import { FakeTimer } from "../fakes/FakeTimer";

describe("setDeviceResources", () => {
  let controller: FakeDeviceResourceController;
  let timer: FakeTimer;
  const device = {
    platform: "ios" as const,
    name: "iPhone",
    deviceId: "12345678-1234-1234-1234-123456789ABC",
  };
  beforeEach(() => {
    controller = new FakeDeviceResourceController();
    timer = new FakeTimer();
    setDeviceToolsDependencies({ deviceResourceControllerFactory: () => controller, timer });
    registerDeviceTools();
  });
  afterEach(() => resetDeviceToolsDependencies());

  test("registers a device-aware opt-in tool", () => {
    expect(ToolRegistry.getTool("setDeviceResources")).toMatchObject({
      defaultEnabled: false,
      requiresDevice: true,
    });
  });

  test.each([
    {},
    { profile: "efficient" },
    { wallpaperRendering: true },
    { wallpaperRendering: "unknown" },
    { "com.apple.apsd": "disabled" },
    { backgroundSnyc: "disabled" },
  ])("rejects invalid resource settings %j", (resources) => {
    expect(deviceResourceConfigurationSchema.safeParse(resources).success).toBe(false);
  });

  test.each(["android", "ios"])("accepts the same resource configuration on %s", (platform) => {
    expect(
      setDeviceResourcesSchema.parse({
        platform,
        resources: {
          wallpaperRendering: "disabled",
          widgets: "enabled",
          liveActivities: "disabled",
          photoAnalysis: "enabled",
          healthServices: "disabled",
        },
      }).resources,
    ).toEqual({
      wallpaperRendering: "disabled",
      widgets: "enabled",
      liveActivities: "disabled",
      photoAnalysis: "enabled",
      healthServices: "disabled",
    });
  });

  test("passes the resolved device and bounded deadline through the controller", async () => {
    const tool = ToolRegistry.getTool("setDeviceResources")!;
    const response = await tool.deviceAwareHandler!(device, {
      resources: { wallpaperRendering: "disabled" },
      timeoutMs: 10_000,
    });
    expect(controller.requests).toHaveLength(1);
    expect(controller.requests[0]).toMatchObject({
      device,
      resources: { wallpaperRendering: "disabled" },
      deadlineMs: 10_000,
    });
    expect(controller.requests[0]!.signal).toBeDefined();
    expect(JSON.parse(response.content[0].text).success).toBe(true);
  });

  test("accepts injected execution metadata and honors the transport deadline", async () => {
    const tool = ToolRegistry.getTool("setDeviceResources")!;
    await tool.deviceAwareHandler!(device, {
      resources: { wallpaperRendering: "disabled" },
      timeoutMs: 10_000,
      __executionId: "exec",
      __executionStartTime: 0,
      __mcpSessionId: "session",
      __mcpRequestDeadlineMs: 9_000,
      __mcpRequestTimeoutMs: 9_000,
      __mcpLiveDeadlineKey: "key",
    });
    expect(controller.requests[0]!.deadlineMs).toBe(4_000);
  });

  test("unsupported and unverified results are tool errors with structured evidence", async () => {
    controller.result = {
      success: false,
      requested: { wallpaperRendering: "disabled" },
      resources: { wallpaperRendering: { state: "unsupported", reason: "not implemented" } },
      changed: [],
      verification: "current_boot",
    };
    const response = await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(device, {
      resources: { wallpaperRendering: "disabled" },
    });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      success: false,
      resources: { wallpaperRendering: { state: "unsupported" } },
    });
  });

  test("same-device configuration is serialized and leases release on failure", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    controller.onRequest = async () => {
      if (controller.requests.length === 1) {
        await pending;
      }
    };
    const handler = ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!;
    const first = handler(device, { resources: { wallpaperRendering: "disabled" } });
    for (let i = 0; i < 20 && controller.requests.length === 0; i++) {
      await Promise.resolve();
    }
    const second = handler(device, { resources: { wallpaperRendering: "enabled" } });
    await Promise.resolve();
    expect(controller.requests).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(controller.requests).toHaveLength(2);
    controller.onRequest = async () => {
      throw new Error("failed");
    };
    await expect(handler(device, { resources: { wallpaperRendering: "enabled" } })).rejects.toThrow(
      "failed",
    );
    controller.onRequest = undefined;
    await handler(device, { resources: { wallpaperRendering: "enabled" } });
    expect(controller.requests).toHaveLength(4);
  });

  test("caller cancellation while waiting never reaches the controller", async () => {
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(
      ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(
        device,
        { resources: { wallpaperRendering: "disabled" } },
        undefined,
        signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(controller.requests).toHaveLength(0);
  });
});
