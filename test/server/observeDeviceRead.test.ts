import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BootedDevice, ObserveResult } from "../../src/models";
import {
  hasObservationReadAccess,
  defaultDeviceObservationAccess,
  type DeviceObservationAccess,
} from "../../src/server/deviceObservationAccess";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { observationScreenshotEvidence } from "../../src/features/observe/screenshot/observationScreenshotEvidence";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import toolDefinitions from "../../schemas/tool-definitions.json";
import { DaemonState } from "../../src/daemon/daemonState";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../fakes/FakeScreenshotStateStore";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { resetObserveCacheStore } from "../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import type { Plan } from "../../src/models/Plan";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { getStructuredField } from "../../src/utils/toolUtils";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const originalManager = Reflect.get(ToolRegistry, "deviceSessionManager");
const callDeviceRead = (args: Record<string, unknown>) =>
  runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
    ToolRegistry.getTool("observe")!.handler(args),
  );

afterEach(() => {
  Reflect.set(ToolRegistry, "deviceSessionManager", originalManager);
  DaemonState.getInstance().reset();
  ToolRegistry.clearTools();
  resetObserveCacheStore();
  resetScreenshotStateStore();
});

describe("session-free observe device read", () => {
  test("retired screenshot tool is absent from live and generated definitions", () => {
    registerObserveTools();
    const retiredName = ["capture", "Device", "Screenshot"].join("");
    expect(ToolRegistry.getToolDefinitions().map((tool) => tool.name)).not.toContain(retiredName);
    expect(toolDefinitions.map((tool) => tool.name)).not.toContain(retiredName);
  });

  test("returns observation and screenshot path without session acquisition or ownership changes", async () => {
    const manager = new FakeDeviceSessionManager();
    Reflect.set(ToolRegistry, "deviceSessionManager", manager);
    ToolRegistry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    const calls: string[] = [];
    const ownershipCalls: string[] = [];
    const daemon = DaemonState.getInstance();
    Reflect.set(daemon, "sessionManager", {
      getDeviceLabels: () => undefined,
      acquireSession: () => ownershipCalls.push("session-acquire"),
    });
    Reflect.set(daemon, "devicePool", {
      getDevice: () => ({ sessionId: undefined }),
      acquireDevice: () => ownershipCalls.push("pool-acquire"),
      releaseDevice: () => ownershipCalls.push("pool-release"),
      autolockDevice: () => ownershipCalls.push("pool-autolock"),
    });
    Reflect.set(daemon, "deviceSessionRegistry", {});
    const access: DeviceObservationAccess = {
      listBooted: async () => {
        calls.push("discover");
        return [device];
      },
      isAuthorized: () => {
        calls.push("authorize");
        return defaultDeviceObservationAccess.isAuthorized(device);
      },
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "observe-device-read-"));
    try {
      const screenshotPath = path.join(dir, "screen.png");
      await fs.writeFile(screenshotPath, Buffer.from("89504e470d0a1a0a", "hex"));
      const observation: ObserveResult = {
        ...loadAndroidHomeObserve().observe,
        deviceId: device.deviceId,
        screenshotPath,
        screenshotSource: "fresh",
        screenshotCaptureSource: "device",
      };
      registerObserveTools({
        deviceReadAccess: access,
        createScreen: () => ({
          executeDeviceRead: async (_signal, screenshot) => {
            expect(screenshot).toBe("settled");
            return observation;
          },
          execute: async (options) => {
            expect(options?.screenshot).toBe("settled");
            return observation;
          },
          appendRawViewHierarchy: async () => {},
          getMostRecentCachedObserveResult: async () => observation,
        }),
      });
      const result = await callDeviceRead({ deviceId: device.deviceId });
      expect(result.structuredContent).toMatchObject({
        deviceId: device.deviceId,
        screenshotPath,
        screenshotSource: "fresh",
      });
      expect((await fs.stat(screenshotPath)).isFile()).toBe(true);
      expect(calls).toEqual(["discover", "authorize", "authorize"]);
      expect(manager.getEnsureDeviceReadyCalls()).toBe(0);
      expect(manager.getSetCurrentDeviceCalls()).toEqual([]);
      expect(ownershipCalls).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("device-id read includes the captured screenshot image when requested", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "observe-device-image-"));
    try {
      const screenshotPath = path.join(dir, "screen.png");
      const screenshotBytes = Buffer.from("89504e470d0a1a0a", "hex");
      await fs.writeFile(screenshotPath, screenshotBytes);
      registerObserveTools({
        deviceReadAccess: { listBooted: async () => [device], isAuthorized: () => true },
        createScreen: () => ({
          executeDeviceRead: async (_signal, screenshot) => {
            expect(screenshot).toBe("settled");
            return { ...loadAndroidHomeObserve().observe, screenshotPath };
          },
          execute: async () => {
            throw new Error("device read entered session observe");
          },
          appendRawViewHierarchy: async () => {},
          getMostRecentCachedObserveResult: async () => loadAndroidHomeObserve().observe,
        }),
      });
      const response = await callDeviceRead({
        deviceId: device.deviceId,
        includeScreenshotImage: true,
      });
      expect(getStructuredField(response, "screenshotImage")).toMatchObject({
        included: true,
        mimeType: "image/png",
      });
      expect(response.content).toContainEqual({
        type: "image",
        data: screenshotBytes.toString("base64"),
        mimeType: "image/png",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("owner access requires the matching transport binding", () => {
    expect(hasObservationReadAccess("owner", "owner", undefined)).toBe(false);
    expect(hasObservationReadAccess("owner", "other", () => true)).toBe(false);
    expect(hasObservationReadAccess("owner", "owner", () => false)).toBe(false);
    expect(hasObservationReadAccess("owner", "owner", () => true)).toBe(true);
    expect(hasObservationReadAccess(undefined, undefined, undefined)).toBe(true);
  });

  test("registry ownership denies a device held by another session", async () => {
    const daemon = DaemonState.getInstance();
    Reflect.set(daemon, "sessionManager", { getDeviceLabels: () => undefined });
    Reflect.set(daemon, "devicePool", { getDevice: () => ({ sessionId: "owner" }) });
    Reflect.set(daemon, "deviceSessionRegistry", {});
    registerObserveTools({
      deviceReadAccess: {
        listBooted: async () => [device],
        isAuthorized: defaultDeviceObservationAccess.isAuthorized,
      },
    });
    await expect(
      runWithToolSelectionContext(
        {
          explicitObserveDeviceRead: true,
          routingSessionUuid: "other",
          ownsDeviceSession: () => false,
        },
        () => ToolRegistry.getTool("observe")!.handler({ deviceId: device.deviceId }),
      ),
    ).rejects.toThrow("Observation access denied.");
  });

  test("published observe alone exposes deviceId and rejects mixed routing", async () => {
    registerObserveTools();
    const live = ToolRegistry.getToolDefinitions();
    const observe = live.find((entry) => entry.name === "observe")!;
    expect(observe.inputSchema.properties).toHaveProperty("deviceId");
    expect(
      (
        toolDefinitions.find((entry) => entry.name === "observe")!.inputSchema as {
          properties: object;
        }
      ).properties,
    ).toHaveProperty("deviceId");
    expect(
      live
        .filter((entry) => entry.name !== "observe")
        .every((entry) => !Object.hasOwn(entry.inputSchema.properties ?? {}, "deviceId")),
    ).toBe(true);
    await expect(
      callDeviceRead({ deviceId: device.deviceId, sessionUuid: "owner" }),
    ).rejects.toThrow("mutually exclusive");
  });

  test("a plan observe step with injected deviceId keeps normal readiness and screenshot mode", async () => {
    const manager = new FakeDeviceSessionManager();
    manager.setConnectedDevices([device]);
    Reflect.set(ToolRegistry, "deviceSessionManager", manager);
    ToolRegistry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    const modes: Array<string | undefined> = [];
    registerObserveTools({
      createScreen: () => ({
        execute: async (options) => {
          modes.push(options?.screenshot);
          return loadAndroidHomeObserve().observe;
        },
        executeDeviceRead: async () => {
          throw new Error("plan entered device read");
        },
        appendRawViewHierarchy: async () => {},
        getMostRecentCachedObserveResult: async () => loadAndroidHomeObserve().observe,
      }),
    });
    const plan: Plan = { name: "observe routing", steps: [{ tool: "observe", params: {} }] };
    const result = await new DefaultPlanExecutor().executePlan(plan, 0, "android", device.deviceId);
    expect(result.success).toBe(true);
    expect(manager.getEnsureDeviceReadyCalls()).toBeGreaterThan(0);
    expect(modes).toEqual([undefined]);
  });

  test("real screen device read has no setup, shared-state writes or session calls", async () => {
    const manager = new FakeDeviceSessionManager();
    Reflect.set(ToolRegistry, "deviceSessionManager", manager);
    ToolRegistry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    const timer = new FakeTimer();
    const cache = new FakeObserveCacheStore(timer);
    const screenshotState = new FakeScreenshotStateStore(timer);
    const adb = new FakeAdbExecutor();
    const factory = new FakeAdbClientFactory(adb);
    const notify = spyOn(ResourceRegistry, "notifyResourcesUpdated");
    const nav = spyOn(NavigationGraphManager, "getInstance");
    const proxy = spyOn(AndroidCtrlProxyManager, "getInstance");
    let audits = 0;
    const restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      auditRunner: {
        run: async () => {
          audits++;
          throw new Error("device read ran audit");
        },
      },
    });
    try {
      registerObserveTools({
        deviceReadAccess: { listBooted: async () => [device], isAuthorized: () => true },
        createScreen: (target) =>
          new RealObserveScreen(
            target,
            factory,
            {
              cacheStore: cache,
              screenshotStateStore: screenshotState,
              screenshotEvidenceFiles: {
                stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 0 }),
              },
              screenshot: {
                execute: async () => ({ success: true, path: "/fake/read.png" }),
                generateScreenshotPath: () => "/fake/read.png",
                getActivityHash: async () => "",
              },
              deviceReadOnly: true,
            },
            timer,
          ),
      });
      const response = await callDeviceRead({ deviceId: device.deviceId });
      expect(response.structuredContent).toMatchObject({ screenshotPath: "/fake/read.png" });
      expect(cache.getPutCallCount()).toBe(0);
      expect(screenshotState.getPath(device.deviceId)).toBeUndefined();
      expect(manager.getEnsureDeviceReadyCalls()).toBe(0);
      expect(manager.getSetCurrentDeviceCalls()).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      expect(nav).not.toHaveBeenCalled();
      expect(proxy).not.toHaveBeenCalled();
      expect(audits).toBe(0);
      expect(adb.getExecutedCommands()).toEqual([]);
    } finally {
      notify.mockRestore();
      nav.mockRestore();
      proxy.mockRestore();
      restorePipeline();
    }
  });

  test("device read passes WebP encoding options into capture and reports its MIME type", async () => {
    const capturedOptions: unknown[] = [];
    registerObserveTools({
      deviceReadAccess: { listBooted: async () => [device], isAuthorized: () => true },
      createScreen: (target) =>
        new RealObserveScreen(target, new FakeAdbClientFactory(new FakeAdbExecutor()), {
          deviceReadOnly: true,
          screenshotEvidenceFiles: {
            stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 0 }),
          },
          screenshot: {
            execute: async (options) => {
              capturedOptions.push(options);
              return { success: true, path: "/fake/read.webp" };
            },
            generateScreenshotPath: () => "/fake/read.webp",
            getActivityHash: async () => "",
          },
        }),
    });
    const response = await callDeviceRead({
      deviceId: device.deviceId,
      screenshot: "settled",
      screenshotOptions: { format: "webp", quality: 80 },
    });
    expect(capturedOptions).toEqual([{ format: "webp", quality: 80, displayId: undefined }]);
    expect(response.structuredContent).toMatchObject({
      screenshotPath: "/fake/read.webp",
      screenshotFormat: "webp",
      screenshotMimeType: "image/webp",
      screenshotSource: "fresh",
    });
  });

  test("cached device screenshot matches the requested display and reports jpeg", async () => {
    const timer = new FakeTimer();
    const cache = new FakeObserveCacheStore(timer);
    const dualDevice: BootedDevice = {
      ...device,
      displays: {
        panels: [
          { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
          { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
        ],
        postures: ["closed"],
      },
    };
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
      stderr: "",
    });
    const cached = {
      ...loadAndroidHomeObserve().observe,
      display: { key: "cover", role: "cover", posture: "closed", generation: 0 },
      viewHierarchy: { hierarchy: {}, displayId: 2 },
      screenshotPath: "/fake/cover.jpg",
    } as ObserveResult;
    await cache.put(device.deviceId, cached);
    const makeScreen = (display: string) =>
      new RealObserveScreen(
        dualDevice,
        new FakeAdbClientFactory(adb),
        {
          display,
          deviceReadOnly: true,
          cacheStore: cache,
          screenshotEvidenceFiles: {
            stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 0 }),
          },
          screenshot: {
            execute: async () => ({ success: false, error: "capture failed" }),
            generateScreenshotPath: () => "/fake/new.png",
            getActivityHash: async () => "",
          },
        },
        timer,
      );
    const wrong = await makeScreen("inner").executeDeviceRead();
    expect(wrong.screenshotPath).toBeUndefined();
    const wrongId = await makeScreen("cover").executeDeviceRead();
    expect(wrongId.screenshotPath).toBeUndefined();
    cached.viewHierarchy!.displayId = 0;
    const matching = await makeScreen("cover").executeDeviceRead();
    expect(matching).toMatchObject({
      screenshotPath: "/fake/cover.jpg",
      screenshotSource: "cached",
      screenshotFormat: "jpeg",
      screenshotMimeType: "image/jpeg",
    });
  });

  test("denies a device read before capture and does not acquire a session", async () => {
    const manager = new FakeDeviceSessionManager();
    Reflect.set(ToolRegistry, "deviceSessionManager", manager);
    ToolRegistry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    let captures = 0;
    registerObserveTools({
      deviceReadAccess: {
        listBooted: async () => [device],
        isAuthorized: () => false,
      },
      createScreen: () => ({
        executeDeviceRead: async () => {
          captures++;
          return loadAndroidHomeObserve().observe;
        },
        execute: async () => {
          captures++;
          return loadAndroidHomeObserve().observe;
        },
        appendRawViewHierarchy: async () => {},
        getMostRecentCachedObserveResult: async () => loadAndroidHomeObserve().observe,
      }),
    });
    await expect(callDeviceRead({ deviceId: device.deviceId })).rejects.toThrow(
      "Observation access denied.",
    );
    expect(captures).toBe(0);
    expect(manager.getEnsureDeviceReadyCalls()).toBe(0);
    expect(manager.getSetCurrentDeviceCalls()).toEqual([]);
  });

  test("withholds an observation if ownership changes during capture", async () => {
    const manager = new FakeDeviceSessionManager();
    Reflect.set(ToolRegistry, "deviceSessionManager", manager);
    ToolRegistry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    const after = spyOn(Reflect.get(ToolRegistry, "afterToolCall"), "handle");
    let authorized = true;
    registerObserveTools({
      deviceReadAccess: {
        listBooted: async () => [device],
        isAuthorized: () => authorized,
      },
      createScreen: () => ({
        executeDeviceRead: async () => {
          authorized = false;
          return loadAndroidHomeObserve().observe;
        },
        execute: async () => {
          authorized = false;
          return loadAndroidHomeObserve().observe;
        },
        appendRawViewHierarchy: async () => {},
        getMostRecentCachedObserveResult: async () => loadAndroidHomeObserve().observe,
      }),
    });
    await expect(callDeviceRead({ deviceId: device.deviceId })).rejects.toThrow(
      "Observation access denied.",
    );
    expect(after).not.toHaveBeenCalled();
    after.mockRestore();
    expect(manager.getEnsureDeviceReadyCalls()).toBe(0);
    expect(manager.getSetCurrentDeviceCalls()).toEqual([]);
  });

  test("describes fresh and cached files with source, age, timestamp and failure", async () => {
    const timer = new FakeTimer();
    timer.advanceTime(10_000);
    const files = {
      stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 8_000 }),
    };
    expect(
      await observationScreenshotEvidence("/screen.png", "fresh", undefined, files, timer),
    ).toMatchObject({
      screenshotPath: "/screen.png",
      screenshotSource: "fresh",
      screenshotCaptureSource: "device",
      screenshotCapturedAt: "1970-01-01T00:00:08.000Z",
      screenshotAgeMs: 2_000,
    });
    expect(
      await observationScreenshotEvidence("/cached.png", "cached", "capture failed", files, timer),
    ).toMatchObject({
      screenshotPath: "/cached.png",
      screenshotSource: "cached",
      screenshotCaptureSource: "observation-cache",
      screenshotCapturedAt: "1970-01-01T00:00:08.000Z",
      screenshotAgeMs: 2_000,
      screenshotFreshFailure: {
        code: "SCREENSHOT_CAPTURE_FAILED",
        message: "capture failed",
        retryable: true,
      },
    });
  });
});
