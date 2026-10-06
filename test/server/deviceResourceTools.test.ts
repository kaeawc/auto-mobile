import { FakeDeviceResourceObserver } from "../fakes/FakeDeviceResourceObserver";
import { DefaultDeviceResourceObserver } from "../../src/utils/deviceResourceObserver";
import { DefaultDeviceResourceController } from "../../src/utils/deviceResourceController";
import { FakeWallpaperSimctl, FakeWallpaperPlist } from "../fakes/FakeIosResourceRuntime";
import { iosDeviceResourceCatalog } from "../../src/utils/iosDeviceResourceCatalog";
import { androidDeviceResourceCatalog } from "../../src/utils/androidDeviceResourceCatalog";
import { logger } from "../../src/utils/logger";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import {
  INTERNAL_TOOL_PARAM_NAMES,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
} from "../../src/daemon/constants";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/server/internalToolCall";

isolateToolRegistry();

describe("setDeviceResources", () => {
  let controller: FakeDeviceResourceController;
  let timer: FakeTimer;
  let observer: FakeDeviceResourceObserver;
  const device = {
    platform: "ios" as const,
    name: "iPhone",
    deviceId: "12345678-1234-1234-1234-123456789ABC",
  };
  beforeEach(() => {
    controller = new FakeDeviceResourceController();
    timer = new FakeTimer();
    observer = new FakeDeviceResourceObserver();
    observer.result.resources.wallpaperRendering = { state: "disabled" };
    setDeviceToolsDependencies({
      deviceResourceControllerFactory: () => controller,
      deviceResourceObserverFactory: () => observer,
      timer,
    });
    registerDeviceTools();
  });
  afterEach(() => resetDeviceToolsDependencies());

  test.each(["android", "ios"] as const)(
    "returns the independent full %s snapshot without changing mutation fields",
    async (platform) => {
      const target = { ...device, platform };
      const common = observer.result.resources;
      observer.result =
        platform === "android"
          ? {
              deviceId: target.deviceId,
              platform,
              resources: {
                ...common,
                googlePlayServices: { state: "unsupported", reason: "No read path" },
              },
            }
          : {
              ...observer.result,
              deviceId: target.deviceId,
              platform: "ios",
              resources: {
                ...common,
                icloudSync: { state: "unsupported" },
                photoAnalysis: { state: "unknown" },
              },
            };
      const catalog = platform === "ios" ? iosDeviceResourceCatalog : androidDeviceResourceCatalog;
      Object.assign(
        observer.result.resources,
        Object.fromEntries(
          Object.keys(catalog).map((key) => [
            key,
            { state: "unknown", reason: "Not verified in fake" },
          ]),
        ),
      );
      controller.result.services = { wallpaperRendering: { native: { state: "disabled" } } };
      controller.result.restore = {
        deviceId: target.deviceId,
        bootId: "boot",
        userId: 0,
        entries: [],
      };
      const response = await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(
        target,
        { resources: controller.result.requested, timeoutMs: 10_000 },
      );
      const payload = JSON.parse(response.content[0].text);
      expect(payload).toEqual({ device: target, ...controller.result, observed: observer.result });
      expect(Object.keys(payload.observed.resources)).toEqual(
        expect.arrayContaining(Object.keys(catalog)),
      );
      expect(observer.requests[0]).toEqual({
        device: target,
        deadlineMs: timer.now() + (controller.requests[0]!.deadlineMs - timer.now()) / 2,
        signal: controller.requests[0]!.signal,
      });
      expect(response.isError).toBeUndefined();
    },
  );

  test.each(["enabled", "disabled"] as const)(
    "explicit opposite observation contradicts requested %s",
    async (requested) => {
      observer.result.resources.wallpaperRendering = {
        state: requested === "enabled" ? "disabled" : "enabled",
      };
      const response = await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(
        device,
        { resources: { wallpaperRendering: requested } },
      );
      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0].text)).toEqual({
        device,
        ...controller.result,
        requested: { wallpaperRendering: requested },
        success: false,
        observed: observer.result,
        observationContradictions: ["wallpaperRendering"],
      });
      expect(controller.result.success).toBe(true);
    },
  );

  test.each(["unknown", "unsupported"] as const)(
    "%s observation preserves successful mutation",
    async (state) => {
      observer.result.resources.wallpaperRendering = { state, reason: "Not observed" };
      const response = await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(
        device,
        { resources: controller.result.requested },
      );
      expect(response.isError).toBeUndefined();
      expect(JSON.parse(response.content[0].text)).toEqual({
        device,
        ...controller.result,
        observed: observer.result,
      });
    },
  );

  test("an undefined requested entry is omitted, never a contradiction", async () => {
    observer.result.resources.wallpaperRendering = { state: "enabled" };
    const requested = { widgets: "enabled" as const, wallpaperRendering: undefined };
    const response = await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(device, {
      resources: requested,
    });
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0].text).observationContradictions).toBeUndefined();
  });

  test("logs observation failure and keeps successful mutation evidence", async () => {
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    observer.onRequest = async () => {
      throw new Error("observation timed out");
    };
    try {
      const response = await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(
        device,
        { resources: controller.result.requested },
      );
      expect(JSON.parse(response.content[0].text)).toEqual({ device, ...controller.result });
      expect(response.isError).toBeUndefined();
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test("propagates cancellation during observation and releases the lease", async () => {
    const abort = new AbortController();
    const reason = new Error("observation cancelled");
    observer.onRequest = async () => {
      abort.abort(reason);
    };
    const handler = ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!;
    await expect(
      handler(device, { resources: controller.result.requested }, undefined, abort.signal),
    ).rejects.toBe(reason);
    observer.onRequest = undefined;
    await handler(device, { resources: controller.result.requested });
    expect(observer.requests).toHaveLength(2);
  });

  test("propagates observer AbortError even without an aborted caller signal", async () => {
    observer.onRequest = async () => {
      throw new DOMException("cancelled", "AbortError");
    };
    await expect(
      ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(device, {
        resources: controller.result.requested,
      }),
    ).rejects.toThrow("cancelled");
  });

  test("observes the native fake runtime after the real controller writes", async () => {
    const simctl = new FakeWallpaperSimctl();
    const plist = new FakeWallpaperPlist();
    const readDirectory = (path: string) => plist.readDirectory(path);
    setDeviceToolsDependencies({
      deviceResourceControllerFactory: () =>
        new DefaultDeviceResourceController(simctl, plist, timer, readDirectory),
      deviceResourceObserverFactory: () =>
        new DefaultDeviceResourceObserver({ simctl, plist, timer, readDirectory }),
    });
    const response = await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(device, {
      resources: { wallpaperRendering: "disabled" },
    });
    const payload = JSON.parse(response.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.observed.resources.wallpaperRendering.state).toBe("disabled");
    expect(Object.keys(payload.observed.resources)).toEqual(
      expect.arrayContaining(Object.keys(iosDeviceResourceCatalog)),
    );
  });
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

  test("forwards restoration through the same device lifecycle path", async () => {
    const restore = {
      deviceId: "emulator-5580",
      bootId: "11111111-1111-4111-8111-111111111111",
      userId: 0,
      entries: [
        { resource: "animations", kind: "global", target: "animator_duration_scale", value: null },
      ],
    };
    const android = {
      platform: "android" as const,
      deviceId: "emulator-5580",
      name: "resource-lab",
    };
    await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(android, { restore });
    expect(controller.requests[0]).toMatchObject({ device: android, resources: {}, restore });
    expect(controller.requests[0]!.signal).toBeDefined();
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

  test("accepts every canonical internal param without mutating the caller", async () => {
    const metadata = Object.fromEntries(INTERNAL_TOOL_PARAM_NAMES.map((key) => [key, true]));
    const args = Object.freeze({
      resources: { wallpaperRendering: "disabled" },
      timeoutMs: 10_000,
      ...metadata,
      [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 9_000,
      [INTERNAL_NO_DIFF_PARAM]: true,
    });
    await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(device, args);
    expect(controller.requests).toHaveLength(1);
    expect(controller.requests[0]).toMatchObject({
      device,
      resources: args.resources,
      deadlineMs: 4_000,
    });
    expect(Object.keys(args)).toEqual([
      "resources",
      "timeoutMs",
      ...INTERNAL_TOOL_PARAM_NAMES,
      INTERNAL_NO_DIFF_PARAM,
    ]);
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
