import { toolIsError, toolJson } from "../helpers/toolResponse";
import { underRequestDeadline, withWireDeadline } from "../helpers/requestDeadline";
import { FakeDeviceResourceObserver } from "../fakes/FakeDeviceResourceObserver";
import { DefaultDeviceResourceObserver } from "../../src/utils/deviceResourceObserver";
import { DefaultDeviceResourceController } from "../../src/utils/deviceResourceController";
import { FakeWallpaperSimctl, FakeWallpaperPlist } from "../fakes/FakeIosResourceRuntime";
import { iosDeviceResourceCatalog } from "../../src/utils/iosDeviceResourceCatalog";
import { describeDisabledDeviceResources } from "../../src/utils/iosDeviceResourceImpact";
import { androidDeviceResourceCatalog } from "../../src/utils/androidDeviceResourceCatalog";
import { logger } from "../../src/utils/logger";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { z } from "zod/v4";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  deviceResourceConfigurationSchema,
  reconcileDeviceResourcesSchema,
  setDeviceResourcesSchema,
} from "../../src/utils/deviceResourceSchemas";
import { FakeDeviceResourceReconciler } from "../fakes/FakeDeviceResourceReconciler";
import { DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
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
} from "../../src/daemon/wire/constants";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/daemon/internalToolCall";

isolateToolRegistry();

const observedResources = z.object({
  observed: z.object({ resources: z.record(z.string(), z.object({ state: z.string() })) }),
});
const driftKinds = z.object({ remainingDrift: z.array(z.object({ kind: z.string() })) });

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

  test("reports disabled impacts and omits them when all resources are enabled", async () => {
    const handler = ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!;
    expect(
      toolJson(await handler(device, { resources: controller.result.requested })).disabledResources,
    ).toEqual([
      expect.objectContaining({
        resource: "wallpaperRendering",
        automobileImpact: expect.any(Array),
        appImpact: expect.any(Array),
      }),
    ]);
    observer.result.resources.wallpaperRendering = { state: "enabled" };
    controller.result.disabledResources = [
      { resource: "wallpaperRendering", labels: [], automobileImpact: [], appImpact: [] },
    ];
    expect(
      toolJson(await handler(device, { resources: controller.result.requested })).disabledResources,
    ).toBeUndefined();
  });

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
      const payload = toolJson(response);
      expect(payload).toEqual({
        device: target,
        ...controller.result,
        observed: observer.result,
        ...(platform === "ios"
          ? { disabledResources: [expect.objectContaining({ resource: "wallpaperRendering" })] }
          : {}),
      });
      expect(Object.keys(observedResources.parse(payload).observed.resources)).toEqual(
        expect.arrayContaining(Object.keys(catalog)),
      );
      expect(observer.requests[0]).toEqual({
        device: target,
        deadlineMs: timer.now() + (controller.requests[0]!.deadlineMs - timer.now()) / 2,
        signal: controller.requests[0]!.signal,
      });
      expect(toolIsError(response)).toBe(false);
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
      expect(toolIsError(response)).toBe(true);
      expect(toolJson(response)).toMatchObject({
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
      expect(toolIsError(response)).toBe(false);
      expect(toolJson(response)).toMatchObject({
        device,
        ...controller.result,
        observed: observer.result,
        disabledResources: [expect.objectContaining({ resource: "wallpaperRendering" })],
      });
    },
  );

  test("includes disabled groups outside the requested map", async () => {
    observer.result.resources.widgets = { state: "disabled" };
    const response = await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(device, {
      resources: controller.result.requested,
    });
    expect(toolJson(response).disabledResources).toEqual([
      expect.objectContaining({ resource: "wallpaperRendering" }),
      expect.objectContaining({ resource: "widgets" }),
    ]);
  });

  test("an undefined requested entry is omitted, never a contradiction", async () => {
    observer.result.resources.wallpaperRendering = { state: "enabled" };
    const requested = { widgets: "enabled" as const, wallpaperRendering: undefined };
    const response = await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(device, {
      resources: requested,
    });
    expect(toolIsError(response)).toBe(false);
    expect(toolJson(response).observationContradictions).toBeUndefined();
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
      expect(toolJson(response)).toMatchObject({ device, ...controller.result });
      expect(toolJson(response).disabledResources).toEqual([
        expect.objectContaining({
          resource: "wallpaperRendering",
          automobileImpact: expect.any(Array),
          appImpact: expect.any(Array),
        }),
      ]);
      expect(toolIsError(response)).toBe(false);
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
        new DefaultDeviceResourceController(simctl, { plist, timer, readDirectory }),
      deviceResourceObserverFactory: () =>
        new DefaultDeviceResourceObserver({ simctl, plist, timer, readDirectory }),
    });
    const response = await ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(device, {
      resources: { wallpaperRendering: "disabled" },
    });
    const payload = toolJson(response);
    expect(payload.success).toBe(true);
    const { resources } = observedResources.parse(payload).observed;
    expect(resources.wallpaperRendering?.state).toBe("disabled");
    expect(Object.keys(resources)).toEqual(
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
    expect(toolJson(response).success).toBe(true);
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
    await withWireDeadline(
      {
        resources: { wallpaperRendering: "disabled" },
        timeoutMs: 10_000,
        __executionId: "exec",
        __executionStartTime: 0,
        __mcpSessionId: "session",
        __mcpRequestDeadlineMs: 9_000,
        __mcpRequestTimeoutMs: 9_000,
        __mcpLiveDeadlineKey: "key",
      },
      (args) => tool.deviceAwareHandler!(device, args),
    );
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
    // The deadline the handler honors is the request's, not one written into its args (#15663).
    await underRequestDeadline({ deadlineMs: 9_000 }, () =>
      ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(device, args),
    );
    expect(controller.requests).toHaveLength(1);
    expect(controller.requests[0]).toMatchObject({
      device,
      resources: args.resources,
      deadlineMs: 4_000,
    });
    expect(Object.keys(args)).toEqual(["resources", "timeoutMs", ...INTERNAL_TOOL_PARAM_NAMES]);
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
    expect(toolIsError(response)).toBe(true);
    expect(toolJson(response)).toMatchObject({
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

describe("reconcileDeviceResources", () => {
  let controller: FakeDeviceResourceController;
  let reconciler: FakeDeviceResourceReconciler;
  let timer: FakeTimer;
  const device = {
    platform: "ios" as const,
    name: "iPhone",
    deviceId: "12345678-1234-1234-1234-123456789ABC",
  };
  beforeEach(() => {
    controller = new FakeDeviceResourceController();
    reconciler = new FakeDeviceResourceReconciler();
    timer = new FakeTimer();
    setDeviceToolsDependencies({
      deviceResourceControllerFactory: () => controller,
      deviceResourceObserverFactory: () => new FakeDeviceResourceObserver(),
      deviceResourceReconcilerFactory: () => reconciler,
      timer,
    });
    registerDeviceTools();
  });
  afterEach(() => resetDeviceToolsDependencies());
  const handler = () => ToolRegistry.getTool("reconcileDeviceResources")!.deviceAwareHandler!;

  test("registers a device-aware opt-in tool", () => {
    expect(ToolRegistry.getTool("reconcileDeviceResources")).toMatchObject({
      defaultEnabled: false,
      requiresDevice: true,
    });
  });

  test("defaults to a report-only run with a bounded deadline", async () => {
    reconciler.result = {
      ...reconciler.result,
      disabledResources: describeDisabledDeviceResources({
        wallpaperRendering: { state: "disabled" },
      }),
    };
    const response = await handler()(device, { resources: { wallpaperRendering: "disabled" } });
    expect(reconciler.requests[0]).toMatchObject({
      device,
      profile: { resources: { wallpaperRendering: "disabled" } },
      repair: false,
      releaseOwnedExtras: false,
      deadlineMs: timer.now() + DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS,
    });
    expect(toolJson(response)).toMatchObject({ device, ...reconciler.result });
    expect(toolJson(response).disabledResources).toEqual([
      expect.objectContaining({
        resource: "wallpaperRendering",
        automobileImpact: expect.any(Array),
        appImpact: expect.any(Array),
      }),
    ]);
    expect(toolIsError(response)).toBe(false);
  });

  test("forwards repair options and reports unproven results as tool errors", async () => {
    reconciler.result = {
      ...reconciler.result,
      success: false,
      remainingDrift: [
        {
          resource: "wallpaperRendering",
          kind: "commandFailure",
          expected: "disabled",
          observed: { state: "unknown", reason: "read failed" },
        },
      ],
    };
    const response = await handler()(device, {
      resources: { wallpaperRendering: "disabled" },
      repair: true,
      releaseOwnedExtras: true,
      timeoutMs: 5_000,
    });
    expect(reconciler.requests[0]).toMatchObject({
      repair: true,
      releaseOwnedExtras: true,
      deadlineMs: timer.now() + 5_000,
    });
    expect(toolIsError(response)).toBe(true);
    expect(driftKinds.parse(toolJson(response)).remainingDrift[0]?.kind).toBe("commandFailure");
  });

  test("shares the per-device lease with setDeviceResources", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    reconciler.onRequest = () => pending;
    const first = handler()(device, { resources: { wallpaperRendering: "disabled" } });
    for (let i = 0; i < 20 && reconciler.requests.length === 0; i++) {
      await Promise.resolve();
    }
    const configure = ToolRegistry.getTool("setDeviceResources")!.deviceAwareHandler!(device, {
      resources: { wallpaperRendering: "enabled" },
    });
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    expect(controller.requests).toHaveLength(0);
    release();
    await Promise.all([first, configure]);
    expect(controller.requests).toHaveLength(1);
  });

  test.each([{}, { profile: "efficient" }, { "com.apple.PosterBoard": "disabled" }])(
    "rejects invalid profiles %j",
    (resources) => {
      expect(reconcileDeviceResourcesSchema.safeParse({ resources }).success).toBe(false);
    },
  );

  test("caller cancellation never reaches the reconciler", async () => {
    await expect(
      handler()(
        device,
        { resources: { wallpaperRendering: "disabled" } },
        undefined,
        AbortSignal.abort(new Error("cancelled")),
      ),
    ).rejects.toThrow("cancelled");
    expect(reconciler.requests).toHaveLength(0);
  });
});
