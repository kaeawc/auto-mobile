import { resolveIosObserveRotation } from "../../src/features/observe/iosObserveRotation";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";
import {
  defaultDeviceObservationAccess,
  type DeviceObservationAccess,
} from "../../src/server/deviceObservationAccess";
import { observeSchema, registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { observationScreenshotEvidence } from "../../src/features/observe/screenshot/observationScreenshotEvidence";
import {
  loadAndroidHomeObserve,
  loadIosFractionalObserve,
} from "../fixtures/observe/observeFixture";
import toolDefinitions from "../../schemas/tool-definitions.json";
import { DaemonState } from "../../src/daemon/daemonState";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { ObserverPendingRequestTimeoutError } from "../../src/features/observe/DeviceServiceClient";
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
import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
} from "../../src/server/directSessionDeviceRegistry";
import { getStructuredField } from "../../src/utils/toolUtils";
import { snapshotReferences } from "../../src/features/observe/SnapshotReferenceStore";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM } from "../../src/daemon/constants";
import { defaultTimer } from "../../src/utils/SystemTimer";
import type { DeviceReadOptions } from "../../src/features/observe/interfaces/ObserveScreen";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const originalManager = Reflect.get(ToolRegistry, "deviceSessionManager");
const callDeviceRead = (args: Record<string, unknown>) =>
  runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
    ToolRegistry.getTool("observe")!.handler(args),
  );

let restoreInventory: () => void;
beforeEach(() => {
  ToolRegistry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
  restoreInventory = ToolRegistry.setPipelineOverridesForTesting({
    displayInventory: new FakeDisplayInventoryProvider(),
  });
});

afterEach(() => {
  restoreInventory();
  Reflect.set(ToolRegistry, "deviceSessionManager", originalManager);
  DaemonState.getInstance().reset();
  ToolRegistry.clearTools();
  resetObserveCacheStore();
  resetScreenshotStateStore();
  clearDirectSessionDevices();
});

describe("session-free observe device read", () => {
  test("all deviceId read forwards the remaining deadline minus the serialization margin", async () => {
    const timer = new FakeTimer();
    timer.advanceTime(1_000);
    const now = spyOn(defaultTimer, "now").mockImplementation(() => timer.now());
    const received: Array<DeviceReadOptions | undefined> = [];
    registerObserveTools({
      timer,
      createScreen: (_device, display) => {
        expect(display).toBe("all");
        return {
          executeDeviceRead: async (_signal, screenshot, encoding, options) => {
            expect(screenshot).toBe("settled");
            expect(encoding).toBeUndefined();
            received.push(options);
            return loadAndroidHomeObserve().observe;
          },
          execute: async () => {
            throw new Error("Session capture must not start");
          },
          appendRawViewHierarchy: async () => {},
          getMostRecentCachedObserveResult: async () => loadAndroidHomeObserve().observe,
        };
      },
    });
    try {
      await runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
        ToolRegistry.getTool("observe")!.deviceAwareHandler!(device, {
          deviceId: device.deviceId,
          display: "all",
          [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: timer.now() + 750,
        }),
      );
      expect(received).toEqual([{ requireFreshScreenshot: false, timeoutMs: 650 }]);
    } finally {
      now.mockRestore();
    }
  });

  test.each([
    [{ waitFor: { text: "Home" } }, "waitFor"],
    [{ includeScreenshotImage: true }, "includeScreenshotImage"],
    [{ raw: true }, "raw"],
  ] as const)("all rejects %j with an actionable error before capture", async (options, option) => {
    let captures = 0;
    registerObserveTools({
      deviceReadAccess: { listBooted: async () => [device], isAuthorized: () => true },
      createScreen: () => {
        captures++;
        throw new Error("Capture must not start");
      },
    });
    const pending = callDeviceRead({ deviceId: device.deviceId, display: "all", ...options });
    await expect(pending).rejects.toBeInstanceOf(ActionableError);
    await expect(pending).rejects.toThrow(`cannot be combined with ${option}`);
    expect(captures).toBe(0);
  });

  test.each([
    [
      { waitFor: { text: "Home" } },
      "waitFor is not available on deviceId reads; use a session observe (pass sessionUuid).",
    ],
    [
      { waitFor: { text: "Home" }, settled: { quietPeriodMs: 1 } },
      "waitFor is not available on deviceId reads; use a session observe (pass sessionUuid).",
    ],
    [
      { raw: true },
      'raw is not available on deviceId reads; use project: "full" for the full filtered hierarchy.',
    ],
    [
      { skipBackStack: true },
      "skipBackStack is not available on deviceId reads; use a session observe (pass sessionUuid) with waitFor.",
    ],
  ])(
    "rejects unsupported device-read options before creating a screen: %j",
    async (options, message) => {
      const calls: string[] = [];
      registerObserveTools({
        deviceReadAccess: { listBooted: async () => [device], isAuthorized: () => true },
        createScreen: () => {
          calls.push("createScreen");
          return {
            executeDeviceRead: async () => {
              calls.push("hierarchy-and-screenshot");
              return loadAndroidHomeObserve().observe;
            },
            execute: async () => {
              calls.push("session-observe");
              return loadAndroidHomeObserve().observe;
            },
            appendRawViewHierarchy: async () => {
              calls.push("raw");
            },
            getMostRecentCachedObserveResult: async () => loadAndroidHomeObserve().observe,
          };
        },
      });
      const promise = callDeviceRead({ deviceId: device.deviceId, ...options });
      await expect(promise).rejects.toBeInstanceOf(ActionableError);
      await expect(promise).rejects.toThrow(message);
      expect(calls).toEqual([]);
    },
  );

  test("settled without waitFor is rejected by the schema", () => {
    const parsed = observeSchema.safeParse({
      deviceId: device.deviceId,
      settled: { quietPeriodMs: 1 },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ message: "settled requires waitFor" }),
      );
    }
  });

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

  test("registry ownership permits a session-free observer", async () => {
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
    expect(defaultDeviceObservationAccess.isAuthorized(device)).toBe(true);
  });

  test.each(["android", "ios"] as const)(
    "owned %s device returns a full observation without changing assignment or owner snapshot references",
    async (platform) => {
      const target = { ...device, platform, deviceId: `${platform}-owned` };
      const owner = { sessionId: "owner", poolStatus: "assigned" };
      const daemon = DaemonState.getInstance();
      Reflect.set(daemon, "sessionManager", { getDeviceLabels: () => undefined });
      Reflect.set(daemon, "devicePool", { getDevice: () => owner });
      Reflect.set(daemon, "deviceSessionRegistry", {});
      const capture = spyOn(snapshotReferences, "capture");
      try {
        const observation =
          platform === "ios" ? loadIosFractionalObserve() : loadAndroidHomeObserve().observe;
        registerObserveTools({
          deviceReadAccess: {
            listBooted: async () => [target],
            isAuthorized: defaultDeviceObservationAccess.isAuthorized,
          },
          createScreen: () => ({
            executeDeviceRead: async () => ({
              ...observation,
              deviceId: target.deviceId,
              screenshotPath: "/fake/owned.png",
              screenshotSource: "fresh",
            }),
            execute: async () => {
              throw new Error("observer entered owner observe");
            },
            appendRawViewHierarchy: async () => {},
            getMostRecentCachedObserveResult: async () => observation,
          }),
        });
        const response = await runWithToolSelectionContext(
          { explicitObserveDeviceRead: true, ownsDeviceSession: () => false },
          () =>
            ToolRegistry.getTool("observe")!.handler({
              deviceId: target.deviceId,
              project: "full",
            }),
        );
        expect(getStructuredField(response, "viewHierarchy")).toBeDefined();
        expect(getStructuredField(response, "screenSize")).toBeDefined();
        expect(getStructuredField(response, "screenshotPath")).toBe("/fake/owned.png");
        expect(owner).toEqual({ sessionId: "owner", poolStatus: "assigned" });
        expect(capture).not.toHaveBeenCalled();
        expect(getStructuredField(response, "snapshotReference")).toBeUndefined();
        expect(getStructuredField(response, "snapshotReferenceUnavailable")).toBeUndefined();
      } finally {
        capture.mockRestore();
      }
    },
  );

  test("published observe alone exposes deviceId", () => {
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
  });

  test("session all omits snapshot references and resource notifications", async () => {
    const sessionUuid = "aggregate-owner";
    const manager = new FakeDeviceSessionManager();
    manager.setConnectedDevices([device]);
    Reflect.set(ToolRegistry, "deviceSessionManager", manager);
    registerDirectSessionDevice(sessionUuid, device);
    const capture = spyOn(snapshotReferences, "capture");
    const notify = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue();
    const recorder = Reflect.get(ToolRegistry, "navigationToolCallRecorder");
    const record = spyOn(recorder, "record").mockImplementation(() => {});
    const restore = ToolRegistry.setPipelineOverridesForTesting({
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
    });
    const observation = { ...loadAndroidHomeObserve().observe, backStack: undefined };
    try {
      registerObserveTools({
        createScreen: (_device, display) => {
          expect(display).toBe("all");
          return {
            execute: async () => observation,
            executeDeviceRead: async () => {
              throw new Error("Must retain session routing");
            },
            appendRawViewHierarchy: async () => {},
            getMostRecentCachedObserveResult: async () => observation,
          };
        },
      });
      const result = await callDeviceRead({
        deviceId: device.deviceId,
        sessionUuid,
        display: "all",
        raw: false,
        includeScreenshotImage: false,
        screenshot: "none",
      });
      expect(getStructuredField(result, "snapshotReference")).toBeUndefined();
      expect(capture).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      restore();
      record.mockRestore();
      capture.mockRestore();
      notify.mockRestore();
    }
  });

  test("matching deviceId and sessionUuid use the session observe pipeline", async () => {
    const sessionUuid = "observe-session";
    const manager = new FakeDeviceSessionManager();
    manager.setConnectedDevices([device]);
    Reflect.set(ToolRegistry, "deviceSessionManager", manager);
    ToolRegistry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    registerDirectSessionDevice(sessionUuid, device);
    const reads: string[] = [];
    const events: string[] = [];
    const navigationRecorder = Reflect.get(ToolRegistry, "navigationToolCallRecorder");
    const record = spyOn(navigationRecorder, "record").mockImplementation(
      (_name, _args, _device, routedSessionUuid) => {
        expect(routedSessionUuid).toBe(sessionUuid);
        events.push("navigation");
      },
    );
    const restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      auditRunner: {
        run: async (input) => {
          events.push("audit");
          return input.handler(input.device, input.args, input.progress, input.signal);
        },
      },
    });
    try {
      registerObserveTools({
        deviceReadAccess: {
          listBooted: async () => {
            reads.push("resolve");
            return [device];
          },
          isAuthorized: () => {
            reads.push("authorize");
            return true;
          },
        },
        createScreen: () => ({
          execute: async (options) => {
            expect(options?.skipBackStack).toBe(true);
            expect(options?.skipScreenshot).toBe(true);
            expect(getToolSelectionContext()?.routingSessionUuid).toBe(sessionUuid);
            expect(getToolSelectionContext()?.explicitObserveDeviceRead).toBe(false);
            events.push("session-observe");
            return { ...loadAndroidHomeObserve().observe, backStack: undefined };
          },
          executeDeviceRead: async () => {
            throw new Error("entered sessionless device read");
          },
          appendRawViewHierarchy: async (result) => {
            events.push("raw");
            result.rawViewHierarchy = {
              json: "{}",
              source: "accessibility-service",
              timestamp: 0,
              device,
            };
          },
          getMostRecentCachedObserveResult: async () => loadAndroidHomeObserve().observe,
        }),
      });
      const response = await callDeviceRead({
        deviceId: device.deviceId,
        sessionUuid,
        waitFor: { activeWindow: { appId: "com.google.android.apps.nexuslauncher" } },
        raw: true,
        skipBackStack: true,
        screenshot: "none",
      });
      expect(getStructuredField(response, "matched")).toBe(true);
      expect(getStructuredField(response, "polls")).toBe(1);
      expect(getStructuredField(response, "rawViewHierarchy")).toBeDefined();
      expect(response.isError).not.toBe(true);
      expect(events).toEqual(["navigation", "audit", "session-observe", "raw"]);
      expect(reads).toEqual([]);
      expect(manager.getLastEnsureDeviceReadyDeviceId()).toBe(device.deviceId);
    } finally {
      restorePipeline();
      record.mockRestore();
    }
  });

  test.each(["runner", "fallback", "missing"] as const)(
    "iOS session reference diagnostics with %s rotation",
    async (rotationSource) => {
      const hasRotation = rotationSource !== "missing";
      const iosDevice: BootedDevice = {
        deviceId: "ios-test-device",
        name: "iPhone",
        platform: "ios",
      };
      const sessionUuid = "ios-observe-session";
      const manager = new FakeDeviceSessionManager();
      manager.setConnectedDevices([iosDevice]);
      Reflect.set(ToolRegistry, "deviceSessionManager", manager);
      ToolRegistry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
      registerDirectSessionDevice(sessionUuid, iosDevice);
      // The existing iOS fixture predates runner frame metadata; supply the typed fields
      // emitted by current CtrlProxy without inventing a second hierarchy fixture.
      const navigationRecorder = Reflect.get(ToolRegistry, "navigationToolCallRecorder");
      const record = spyOn(navigationRecorder, "record").mockImplementation(() => {});
      const restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
        displayInventory: new FakeDisplayInventoryProvider(),
        auditRunner: {
          run: async (input) =>
            input.handler(input.device, input.args, input.progress, input.signal),
        },
      });
      try {
        const fixture = loadIosFractionalObserve();
        const observation: ObserveResult = {
          ...fixture,
          observationId: "ios-capture",
          displayRevision: 0,
          rotation:
            rotationSource === "fallback"
              ? resolveIosObserveRotation(undefined, fixture.screenSize)
              : hasRotation
                ? 0
                : undefined,
          snapshotReferenceUnavailable: ["old-diagnostic"],
          activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 0 },
          viewHierarchy: {
            ...fixture.viewHierarchy!,
            frameContext: "ios-epoch:1:screen",
            nativeScale: 3,
            pixelWidth: 1179,
            pixelHeight: 2556,
            rotation: rotationSource === "runner" ? 0 : undefined,
          },
        };
        registerObserveTools({
          createScreen: () => ({
            execute: async () => observation,
            executeDeviceRead: async () => {
              throw new Error("entered sessionless device read");
            },
            appendRawViewHierarchy: async () => {},
            getMostRecentCachedObserveResult: async () => observation,
          }),
        });
        const response = await ToolRegistry.getTool("observe")!.handler({
          deviceId: iosDevice.deviceId,
          sessionUuid,
        });
        if (hasRotation) {
          expect(getStructuredField(response, "rotation")).toBe(0);
          expect(observation.viewHierarchy?.rotation).toBe(
            rotationSource === "runner" ? 0 : undefined,
          );
          expect(getStructuredField(response, "snapshotReference")).toMatchObject({
            snapshotId: expect.any(String),
            expiresAt: expect.any(Number),
          });
          expect(getStructuredField(response, "snapshotReferenceUnavailable")).toBeUndefined();
        } else {
          expect(getStructuredField(response, "snapshotReference")).toBeUndefined();
          expect(getStructuredField(response, "snapshotReferenceUnavailable")).toEqual([
            "rotation",
          ]);
        }
      } finally {
        restorePipeline();
        record.mockRestore();
      }
    },
  );

  test("mismatching session deviceId identifies the supplied and bound devices", async () => {
    const sessionUuid = "observe-session";
    const suppliedDeviceId = "emulator-5556";
    registerDirectSessionDevice(sessionUuid, device);
    registerObserveTools();
    let rejection: unknown;
    try {
      await callDeviceRead({ deviceId: suppliedDeviceId, sessionUuid });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ActionableError);
    expect((rejection as ActionableError).message).toContain(
      `observe deviceId '${suppliedDeviceId}' does not match session '${sessionUuid}' device '${device.deviceId}'`,
    );
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

  test("real screen device read returns hierarchy without shared-state writes or session calls", async () => {
    const manager = new FakeDeviceSessionManager();
    Reflect.set(ToolRegistry, "deviceSessionManager", manager);
    ToolRegistry.setToolCallRepositoryForTesting({ recordToolCall: async () => {} });
    const timer = new FakeTimer();
    const cache = new FakeObserveCacheStore(timer);
    const ownerObservation = {
      ...loadAndroidHomeObserve().observe,
      displayRevision: 0,
      rotation: 0,
      viewHierarchy: {
        ...loadAndroidHomeObserve().observe.viewHierarchy!,
        nativeScale: 1,
        frameContext: "owner-frame",
      },
    };
    await cache.put(device.deviceId, ownerObservation);
    const ownerSnapshot = snapshotReferences.capture(device.deviceId, ownerObservation);
    expect(ownerSnapshot.status).toBe("captured");
    if (ownerSnapshot.status !== "captured") {
      throw new Error("Owner reference unavailable");
    }
    const priorWrites = cache.getPutCallCount();
    const screenshotState = new FakeScreenshotStateStore(timer);
    const adb = new FakeAdbExecutor();
    adb.setDeviceLock({ locked: false, keyguardShowing: false });
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
              hierarchyCapture: {
                capture: async (request) => {
                  expect(request.observerMode).toBe(true);
                  const hierarchy = loadAndroidHomeObserve().observe.viewHierarchy!;
                  return {
                    captureId: "observer",
                    platform: "android",
                    requestedFreshness: "fresh",
                    receivedAt: timer.now(),
                    hierarchy,
                    nodes: [],
                  };
                },
              },
              deviceReadOnly: true,
            },
            timer,
          ),
      });
      const response = await callDeviceRead({
        deviceId: device.deviceId,
        project: "full",
        screenshot: "settled",
        skipBackStack: false,
        raw: false,
      });
      expect(getStructuredField(response, "snapshotReference")).toBeUndefined();
      expect(response.structuredContent).toMatchObject({ screenshotPath: "/fake/read.png" });
      expect(getStructuredField(response, "viewHierarchy")?.hierarchy?.node).toBeDefined();
      expect(getStructuredField(response, "screenSize")).toMatchObject({
        width: 1080,
        height: 2400,
      });
      expect(getStructuredField(response, "activeWindow")).toBeDefined();
      expect(getStructuredField(response, "display")).toBeDefined();
      expect(getStructuredField(response, "deviceLock")).toEqual({
        locked: false,
        keyguardShowing: false,
      });
      expect(cache.getPutCallCount()).toBe(priorWrites);
      expect(cache.getRecentInMemoryForDevice(device.deviceId)).toEqual(ownerObservation);
      expect(
        snapshotReferences.staleReason(
          ownerSnapshot.reference.snapshotId,
          device.deviceId,
          ownerObservation,
        ),
      ).toBeUndefined();
      expect(screenshotState.getPath(device.deviceId)).toBeUndefined();
      expect(manager.getEnsureDeviceReadyCalls()).toBe(0);
      expect(manager.getSetCurrentDeviceCalls()).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      expect(nav).not.toHaveBeenCalled();
      expect(proxy).not.toHaveBeenCalled();
      expect(audits).toBe(0);
      expect(adb.getExecutedCommands()).toEqual(["shell dumpsys activity activities"]);
    } finally {
      notify.mockRestore();
      nav.mockRestore();
      proxy.mockRestore();
      restorePipeline();
    }
  });

  test.each([
    [
      "owned disconnected client",
      "Device emulator-5554 is session-owned and has no connected hierarchy service",
      "connection_lost",
    ],
    [
      "unowned unreachable service",
      "Device emulator-5554 has no reachable hierarchy service",
      "connection_lost",
    ],
    ["owner request deadline", new ObserverPendingRequestTimeoutError(), "request_timed_out"],
  ] as const)("observer keeps screenshot and reports %s", async (_label, failure, reason) => {
    const timer = new FakeTimer();
    const screen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      {
        deviceReadOnly: true,
        hierarchyCapture: {
          capture: async () => {
            throw failure;
          },
        },
        screenshot: {
          execute: async () => ({ success: true, path: "/fake/unavailable.png" }),
          generateScreenshotPath: () => "/fake/unavailable.png",
          getActivityHash: async () => "",
        },
        screenshotEvidenceFiles: {
          stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 0 }),
        },
      },
      timer,
    );
    let perfAttachments = 0;
    Reflect.set(screen, "attachPerfSnapshot", async () => {
      perfAttachments++;
    });
    const result = await screen.executeDeviceRead();
    expect(result.screenshotPath).toBe("/fake/unavailable.png");
    expect(result.freshness).toMatchObject({
      category: "unavailable",
      unavailableReason: reason,
    });
    expect(result.freshness?.unavailableDetail).toContain(
      failure instanceof Error ? failure.message : failure,
    );
    expect(perfAttachments).toBe(0);
  });

  test("device read passes WebP encoding options into capture and reports its MIME type", async () => {
    const capturedOptions: unknown[] = [];
    registerObserveTools({
      deviceReadAccess: { listBooted: async () => [device], isAuthorized: () => true },
      createScreen: (target) =>
        new RealObserveScreen(target, new FakeAdbClientFactory(new FakeAdbExecutor()), {
          deviceReadOnly: true,
          hierarchyCapture: {
            capture: async () => ({
              captureId: "webp-observer",
              platform: "android",
              requestedFreshness: "fresh",
              receivedAt: 0,
              hierarchy: loadAndroidHomeObserve().observe.viewHierarchy!,
              nodes: [],
            }),
          },
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
          hierarchyCapture: {
            capture: async () => ({
              captureId: "observer-display",
              platform: "android",
              requestedFreshness: "fresh",
              receivedAt: timer.now(),
              hierarchy: {
                ...loadAndroidHomeObserve().observe.viewHierarchy!,
                displayId: display === "inner" ? 2 : 0,
              },
              nodes: [],
            }),
          },
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
