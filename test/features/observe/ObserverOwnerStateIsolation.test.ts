import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../src/models";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { createDeviceHierarchyCapture } from "../../../src/features/observe/DeviceHierarchyCapture";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { snapshotReferences } from "../../../src/features/observe/SnapshotReferenceStore";
import { FileSystemObserveCacheStore } from "../../../src/features/observe/cache/FileSystemObserveCacheStore";
import {
  getObserveCacheStore,
  setObserveCacheStore,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import {
  InMemoryScreenshotStateStore,
  getScreenshotStateStore,
  setScreenshotStateStore,
} from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { DaemonState } from "../../../src/daemon/daemonState";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeAndroidPhysicalDisplayIdResolver } from "../../fakes/FakeAndroidPhysicalDisplayIdResolver";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { Window } from "../../../src/features/observe/Window";

const device: BootedDevice = {
  deviceId: "observer-owner-state-isolation",
  name: "Foldable",
  platform: "android",
  displays: {
    panels: [
      { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
      { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
    ],
    postures: ["closed", "opened"],
  },
};
const displayCommand = "shell cmd display get-displays";
const ownerCommand = "shell input touchscreen tap 10 20";
const png = readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64");
const originalCache = getObserveCacheStore();
const originalScreenshotState = getScreenshotStateStore();
const originalReferences = new Map(
  Reflect.get(snapshotReferences, "entries") as Map<string, unknown>,
);
let directory: string | undefined;
let sessions: SessionManager | undefined;

class HoldingAdb extends FakeAdbExecutor {
  readonly holds = new Map<string, ReturnType<typeof Promise.withResolvers<ExecResult>>>();
  readonly started = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  hold(command: string): void {
    this.holds.set(command, Promise.withResolvers<ExecResult>());
    this.started.set(command, Promise.withResolvers<void>());
  }
  override async executeCommand(
    ...args: Parameters<FakeAdbExecutor["executeCommand"]>
  ): Promise<ExecResult> {
    const result = await super.executeCommand(...args);
    const pending = this.holds.get(args[0]);
    if (!pending) {
      return result;
    }
    this.started.get(args[0])!.resolve();
    await pending.promise;
    args[4]?.throwIfAborted();
    return result;
  }
  release(command: string): void {
    this.holds.get(command)?.resolve({ stdout: "released", stderr: "" });
    this.holds.delete(command);
  }
}

function configure(adb: FakeAdbExecutor, panel = "cover"): void {
  adb.setCommandResponse(displayCommand, {
    stdout: `Display id 0: DisplayInfo{uniqueId "local:${panel}" type INTERNAL, real 100 x 100}`,
    stderr: "",
  });
  adb.setCommandResponse("shell cmd device_state state", {
    stdout: readFileSync(
      "test/fixtures/android-display/foldpf-6-fold-from-closed-base-while-override-state.txt",
      "utf8",
    ),
    stderr: "",
  });
  adb.setCommandResponse("shell cmd device_state print-states", {
    stdout: readFileSync("test/fixtures/android-display/foldpf-print-states.txt", "utf8"),
    stderr: "",
  });
  adb.setCommandResponse("screencap", { stdout: png, stderr: "" });
}

// Capture the actual module-private maps during owner seeding, without adding a production test API.
async function seedDisplay(
  timer: FakeTimer,
  adb: FakeAdbExecutor,
): Promise<Map<unknown, unknown>[]> {
  const maps = new Set<Map<unknown, unknown>>();
  const set = Map.prototype.set;
  const writes = spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown,
  ) {
    if (key === device.deviceId) {
      maps.add(this);
    }
    return set.call(this, key, value);
  });
  try {
    const cache = new ObservedAndroidDisplayCache(timer);
    await cache.resolve(device, adb);
    await cache.posture(device, adb);
    expect(maps.size).toBe(3);
    return [...maps];
  } finally {
    writes.mockRestore();
  }
}

function snapshotMaps(maps: Map<unknown, unknown>[]): unknown {
  return structuredClone(maps.map((map) => [...map]));
}

afterEach(() => {
  sessions?.stopCleanupTimer();
  sessions = undefined;
  AndroidCtrlProxyClient.resetInstances();
  DaemonState.getInstance().reset();
  PortManager.setPortAvailabilityCheckerForTesting(null);
  displayTransitions.reset(device.deviceId);
  ObservedAndroidDisplayCache.release(device.deviceId);
  setObserveCacheStore(originalCache);
  setScreenshotStateStore(originalScreenshotState);
  const entries = Reflect.get(snapshotReferences, "entries") as Map<string, unknown>;
  entries.clear();
  for (const [key, value] of originalReferences) {
    entries.set(key, value);
  }
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
  directory = undefined;
});

test.each(["active", "all"])(
  "device %s read leaves real owner state intact and cannot delay an ADB owner action",
  async (display) => {
    const timer = new FakeTimer();
    const adb = new HoldingAdb();
    configure(adb);
    adb.setCommandResponse(displayCommand, {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
      stderr: "",
    });
    adb.setForegroundApp({ packageName: "com.owner.inner", userId: 0 }, { displayId: 2 });
    const maps = await seedDisplay(timer, adb);
    timer.advanceTime(6000); // An observer must not refresh even expired owner display/posture entries.
    const factory = new FakeAdbClientFactory(adb);
    const writer = new FakeScreenshotFileWriter();
    const shot = new TakeScreenshot(
      device,
      factory,
      timer,
      new CountingIdGenerator("shot"),
      writer,
      new FakeFileSystem(),
      () => "/fake",
      undefined,
      false,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    directory = mkdtempSync(join(tmpdir(), "observer-owner-state-"));
    const store = new FileSystemObserveCacheStore(
      timer,
      directory,
      async () => {},
      new CountingIdGenerator("cache"),
    );
    setObserveCacheStore(store);
    const screenshotState = new InMemoryScreenshotStateStore(timer);
    setScreenshotStateStore(screenshotState);
    const window = new Window(device, factory, timer);
    const ownerWindow = { appId: "com.owner", activityName: "OwnerActivity", layoutSeqSum: 42 };
    Reflect.set(window, "cachedActiveWindow", ownerWindow);
    let windowWrites = 0;
    Reflect.set(window, "writeCacheToDisk", async () => {
      windowWrites++;
    });
    const screen = new RealObserveScreen(
      device,
      factory,
      {
        deviceReadOnly: true,
        display,
        window,
        screenshot: shot,
        hierarchyCapture: createDeviceHierarchyCapture(device, { adbFactory: factory, timer }),
        screenshotEvidenceFiles: {
          stat: async () => ({ isFile: () => true, size: 12, mtimeMs: timer.now() }),
        },
      },
      timer,
      new CountingIdGenerator("read"),
    );
    const baseline = (Reflect.get(screen, "createBaseResult") as () => ObserveResult).call(screen);
    baseline.screenSize = { width: 100, height: 100 };
    baseline.rotation = 0;
    baseline.viewHierarchy = {
      hierarchy: { node: { text: "Owner" } },
      nativeScale: 1,
      frameContext: "owner-frame",
    };
    baseline.observationId = "owner-baseline";
    baseline.display = { key: "cover", role: "cover", posture: "closed", generation: 0 };
    sessions = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const session = await sessions.createSession("owner", device.deviceId, "android");
    sessions.setLastRenderedObservation("owner", baseline);
    await store.put(device.deviceId, baseline, store.currentGeneration(device.deviceId));
    screenshotState.updateForObservation(
      device.deviceId,
      "owner-baseline",
      "/fake/owner.png",
      "owner error",
    );
    screenshotState.beginObservation(device.deviceId, "owner-pending");
    expect(snapshotReferences.capture(device.deviceId, baseline).status).toBe("captured");
    displayTransitions.record(device.deviceId, baseline);
    const daemon = DaemonState.getInstance();
    Reflect.set(daemon, "sessionManager", sessions);
    const assignment = { sessionId: "owner", poolStatus: "assigned" };
    Reflect.set(daemon, "devicePool", {
      getDevice: () => assignment,
      assertDeviceActionable: () => {},
    });
    Reflect.set(daemon, "deviceSessionRegistry", {});
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    let reply!: () => void;
    const client = AndroidCtrlProxyClient.createForTesting(
      device,
      adb,
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, timer);
        spyOn(socket, "send").mockImplementation((wire: string) => {
          const request = JSON.parse(wire) as {
            type?: string;
            requestId?: string;
            displayId?: number;
          };
          if (request.type === "request_hierarchy") {
            const secondary = request.displayId === 2;
            const respond = () =>
              socket.simulateMessage(
                JSON.stringify({
                  type: "hierarchy_update",
                  requestId: request.requestId,
                  data: {
                    updatedAt: 1,
                    hierarchy: {
                      text: secondary ? "Inner" : display === "all" ? "Updated active" : "Owner",
                      bounds: {
                        left: 0,
                        top: 0,
                        right: secondary ? 200 : 100,
                        bottom: secondary ? 200 : 100,
                      },
                    },
                    screenWidth: secondary ? 200 : 100,
                    screenHeight: secondary ? 200 : 100,
                    displayId: request.displayId ?? 0,
                    rotation: 0,
                    // Force the bootstrap Window read; incomplete trees must not run UIAutomator.
                    ctrlProxyIncomplete: true,
                  },
                }),
              );
            if (secondary) {
              setImmediate(respond);
            } else {
              reply = respond;
            }
          }
        });
        return socket;
      },
      timer,
    );
    await client.ensureConnected();
    AndroidCtrlProxyClient.registerForTesting(client, device.deviceId);
    // The ordinary read is equal; aggregate active and secondary frames differ from this owner seed.
    Reflect.set(client, "cachedHierarchy", {
      hierarchy: {
        updatedAt: 1,
        hierarchy: { text: "Owner", bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
        screenWidth: 100,
        screenHeight: 100,
        displayId: 0,
        rotation: 0,
      },
      fresh: true,
    });
    const references = Reflect.get(snapshotReferences, "entries") as Map<string, unknown>;
    const before = {
      session: structuredClone(session.cacheData),
      references: structuredClone([...references]),
      cache: structuredClone(Reflect.get(store, "cache")),
      generation: store.currentGeneration(device.deviceId),
      screenshot: structuredClone(Reflect.get(screenshotState, "states")),
      observations: structuredClone(Reflect.get(screenshotState, "observationStates")),
      pending: screenshotState.isObservationPending(device.deviceId, "owner-pending"),
      revision: displayTransitions.revision(device.deviceId),
      identity: displayTransitions.identityRevision(device.deviceId),
      display: snapshotMaps(maps),
      hierarchy: structuredClone(Reflect.get(client, "cachedHierarchy")),
    };
    adb.hold(ownerCommand);
    adb.setCommandResponse(ownerCommand, { stdout: "owner result", stderr: "" });
    const controller = new AbortController();
    const owner = adb.executeCommand(
      ownerCommand,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    await adb.started.get(ownerCommand)!.promise;
    const observerCommandsStart = adb.getExecutedCommands().length;
    try {
      const observer = screen.executeDeviceRead();
      for (let i = 0; i < 100 && !reply; i++) {
        await Promise.resolve();
      }
      expect(reply).toBeDefined();
      // The observer is still waiting: releasing the owner must complete it immediately.
      adb.release(ownerCommand);
      expect((await owner).stdout).toBe("owner result");
      expect(controller.signal.aborted).toBe(false);
      await new Promise<void>((resolve) => setImmediate(resolve));
      reply();
      const result = await observer;
      expect(result.screenshotSource).toBe("fresh");
      if (display === "all") {
        expect(result.displays?.map((panel) => panel.display.key)).toEqual(["cover", "inner"]);
        expect(result.displays?.map((panel) => panel.viewHierarchy?.displayId)).toEqual([0, 2]);
        expect(result.displays?.[1].viewHierarchy?.ctrlProxyIncomplete).toBe(true);
      }
      expect(Reflect.get(client, "cachedHierarchy")).toEqual(before.hierarchy);
      const commands = adb.getExecutedCommands().slice(observerCommandsStart);
      const allowlist = [
        /^shell cmd display get-displays$/,
        /^shell cmd device_state (?:state|print-states)$/,
        /^shell dumpsys SurfaceFlinger --display-id$/,
        /^shell "?dumpsys activity activities"?$/,
        /^forward --list$/,
        /^shell "dumpsys window displays"$/,
        /^shell "dumpsys window windows"$/,
        /^shell "screencap (?:-d \d+ )?-p \| base64"$/,
      ];
      expect(commands.length).toBeGreaterThan(0);
      expect(
        commands.filter((command) => !allowlist.some((allowed) => allowed.test(command))),
      ).toEqual([]);
      expect(windowWrites).toBe(0);
      expect(Reflect.get(window, "cachedActiveWindow")).toBe(ownerWindow);
      expect(getObserveCacheStore()).toBe(store);
      expect(getScreenshotStateStore()).toBe(screenshotState);
      expect(session.cacheData).toEqual(before.session);
      expect(sessions.getLastRenderedObservation("owner")).toBe(baseline);
      expect([...references]).toEqual(before.references);
      expect(Reflect.get(store, "cache")).toEqual(before.cache);
      expect(store.currentGeneration(device.deviceId)).toBe(before.generation);
      expect(Reflect.get(screenshotState, "states")).toEqual(before.screenshot);
      expect(Reflect.get(screenshotState, "observationStates")).toEqual(before.observations);
      expect(screenshotState.isObservationPending(device.deviceId, "owner-pending")).toBe(
        before.pending,
      );
      expect(displayTransitions.revision(device.deviceId)).toBe(before.revision);
      expect(displayTransitions.identityRevision(device.deviceId)).toBe(before.identity);
      expect(snapshotMaps(maps)).toEqual(before.display);
      expect(assignment).toEqual({ sessionId: "owner", poolStatus: "assigned" });
    } finally {
      adb.release(ownerCommand);
      timer.enableAutoAdvance();
      await client.close();
    }
  },
);

test.each(["display", "posture"] as const)(
  "late observer %s probe cannot repopulate caches cleared by an owner fold",
  async (probe) => {
    const timer = new FakeTimer();
    const adb = new HoldingAdb();
    configure(adb);
    const maps = await seedDisplay(timer, adb);
    timer.advanceTime(6000);
    const heldCommand = probe === "display" ? displayCommand : "shell cmd device_state state";
    adb.hold(heldCommand);
    const screen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(adb),
      {
        deviceReadOnly: true,
        window: new FakeWindow(),
        hierarchyCapture: {
          capture: async () => ({
            hierarchy: {
              hierarchy: { node: { text: "Cover" } },
              screenWidth: 100,
              screenHeight: 100,
            },
            captureId: "observer",
            platform: "android",
            requestedFreshness: "fresh",
            receivedAt: timer.now(),
            nodes: [],
          }),
        },
      },
      timer,
    );
    const read = screen.executeDeviceRead(undefined, "none");
    await adb.started.get(heldCommand)!.promise;
    const owner = new FakeAdbExecutor();
    configure(owner, "inner");
    owner.setCommandResponse("shell cmd device_state state", {
      stdout: readFileSync("test/fixtures/android-display/foldpf-1-default-state.txt", "utf8"),
      stderr: "",
    });
    await owner.executeCommand("shell cmd device_state state 2");
    ObservedAndroidDisplayCache.clear(device.deviceId);
    const cache = new ObservedAndroidDisplayCache(timer);
    expect((await cache.resolve(device, owner)).display.key).toBe("inner");
    expect(await cache.posture(device, owner)).toBe("opened");
    const afterOwner = snapshotMaps(maps);
    adb.release(heldCommand);
    await read;
    expect(snapshotMaps(maps)).toEqual(afterOwner);
    expect((await cache.resolve(device, owner)).display.key).toBe("inner");
    expect(await cache.posture(device, owner)).toBe("opened");
  },
);

test("incomplete observer hierarchy does not run the device-writing UIAutomator fallback", async () => {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  adb.setForegroundApp({ packageName: "com.owner", userId: 0 });
  const hierarchy = { hierarchy: {}, packageName: "com.owner", ctrlProxyIncomplete: true };
  const capture = createDeviceHierarchyCapture(device, {
    timer,
    adbFactory: new FakeAdbClientFactory(adb),
    syncClientFactory: () => ({
      requestHierarchySync: async () => ({ hierarchy }),
      requestHierarchySyncForObserver: async () => ({ hierarchy }),
      convertToViewHierarchyResult: () => hierarchy,
    }),
  });
  expect(
    (await capture.capture({ freshness: "fresh", observerMode: true })).hierarchy
      .ctrlProxyIncomplete,
  ).toBe(true);
  expect(adb.getExecutedArgv()).toEqual([]);
});

test("observer screenshot buffer failure never falls back to writing or pulling a guest file", async () => {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  adb.setCommandError("screencap", new Error("maxBuffer exceeded"));
  const writer = new FakeScreenshotFileWriter();
  const screenshot = new TakeScreenshot(
    device,
    new FakeAdbClientFactory(adb),
    timer,
    new CountingIdGenerator("buffer"),
    writer,
    new FakeFileSystem(),
    () => "/fake",
    new FakeAndroidPhysicalDisplayIdResolver(new Map([[0, "4619827259835644672"]])),
    false,
    { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
  );
  expect(await screenshot.executeObservationRead({ format: "png", displayId: 0 })).toEqual({
    success: false,
    error: "maxBuffer exceeded",
  });
  expect(adb.getExecutedCommands()).toEqual([
    'shell "screencap -d 4619827259835644672 -p | base64"',
  ]);
  expect(adb.getExecutedArgv()).toEqual([]);
  expect(writer.written).toEqual([]);
});

test("session all read preserves expired display/posture caches and recaptured bootstrap window state", async () => {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  configure(adb);
  adb.setCommandResponse(displayCommand, {
    stdout:
      'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
    stderr: "",
  });
  const maps = await seedDisplay(timer, adb);
  timer.advanceTime(6000);
  const before = snapshotMaps(maps);
  const hierarchy = new FakeViewHierarchy();
  hierarchy.configureHierarchy({
    hierarchy: { node: { text: "Cover" } },
    packageName: "com.owner",
    updatedAt: 1,
    fresh: true,
    displayId: 0,
    screenWidth: 100,
    screenHeight: 100,
  });
  const window = new FakeWindow();
  window.configureActiveWindow({ appId: "com.owner", activityName: "", layoutSeqSum: 42 });
  const cache = new FakeObserveCacheStore(timer);
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(adb),
    {
      display: "all",
      window,
      cacheStore: cache,
      viewHierarchy: hierarchy,
      backStack: {
        execute: async () => ({
          depth: 1,
          activities: [],
          tasks: [],
          currentActivity: { name: "com.owner.MainActivity", taskId: 1 },
          source: "adb",
        }),
      },
      hierarchyCapture: {
        capture: async (request) => ({
          captureId: "inner",
          platform: "android",
          requestedFreshness: request.freshness,
          receivedAt: timer.now(),
          nodes: [],
          hierarchy: {
            hierarchy: { node: { text: "Inner" } },
            displayId: request.displayId,
            screenWidth: 200,
            screenHeight: 200,
          },
        }),
      },
    },
    timer,
  );
  const result = await screen.execute({
    skipScreenshot: true,
    skipRecompositionTracking: true,
    skipPerformanceAudit: true,
    skipAccessibilityAudit: true,
  });
  expect(result.displays?.map((panel) => panel.display.key)).toEqual(["cover", "inner"]);
  expect(snapshotMaps(maps)).toEqual(before);
  expect(window.getGetActiveOptions()).toEqual([
    { cacheResult: false },
    { cacheResult: false },
    { cacheResult: false },
  ]);
  expect(hierarchy.getCallCount()).toBe(2);
  expect(result.activeWindow?.activityName).toBe("com.owner.MainActivity");
  expect(cache.getPutCallCount()).toBe(0);
  expect(displayTransitions.currentObservedPanel(device.deviceId)).toBeUndefined();
});

test("observer readOnly flag is independent of recomposition skipping and logical display id", async () => {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  configure(adb, "inner");
  adb.setCommandResponse(displayCommand, {
    stdout: 'Display id 2: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
    stderr: "",
  });
  const window = new FakeWindow();
  window.configureActiveWindow({ appId: "com.owner", activityName: "", layoutSeqSum: 42 });
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(adb),
    {
      window,
      deviceReadOnly: true,
      hierarchyCapture: {
        capture: async (request) => ({
          captureId: "inner",
          platform: "android",
          requestedFreshness: request.freshness,
          receivedAt: timer.now(),
          nodes: [],
          hierarchy: {
            hierarchy: { node: { text: "Inner" } },
            displayId: request.displayId,
            screenWidth: 200,
            screenHeight: 200,
          },
        }),
      },
    },
    timer,
  );
  const collect = spyOn(screen, "collectAllData");
  try {
    await screen.execute({
      display: "inner",
      observerMode: true,
      skipScreenshot: true,
      skipBackStack: true,
      skipRecompositionTracking: false,
    });
    expect(collect.mock.calls[0]?.[7]).toBe(true);
    expect(collect.mock.calls[0]?.[10]).toBe(2);
    expect(window.getGetActiveOptions()).toEqual([{ cacheResult: false }]);
  } finally {
    collect.mockRestore();
  }
});
