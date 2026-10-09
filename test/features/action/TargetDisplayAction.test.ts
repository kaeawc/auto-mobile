import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../../../src/features/observe/shared/SharedGestureDelegate";
import type WebSocket from "ws";
import { CtrlProxyGestures } from "../../../src/features/observe/android/CtrlProxyGestures";
import { RequestManager } from "../../../src/utils/RequestManager";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { DOUBLE_TAP_GAP_MS } from "../../../src/features/action/tapAtGesture";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { SendKeys } from "../../../src/features/action/SendKeys";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAndroidPhysicalDisplayIdResolver } from "../../fakes/FakeAndroidPhysicalDisplayIdResolver";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import type { SwipeOnOptions } from "../../../src/models/SwipeOnOptions";
import { sessionRenderedObservation } from "../../../src/features/action/TargetDisplayAction";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { DevicePool } from "../../../src/daemon/devicePool";
import { DaemonState } from "../../../src/daemon/daemonState";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { setFakeTapAtWindow } from "../../helpers/tapAtCoordinate";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { runSessionDisplayPin } from "../../../src/server/sessionDisplayPin";
import {
  ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV,
  OBSERVE_SETTLED_SCREENSHOT_ENV,
} from "../../../src/features/observe/automaticScreenshotPolicy";
import { FakeWebSocket, WebSocketState } from "../../fakes/FakeWebSocket";
import { FakeScreenshotBackoffScheduler } from "../../fakes/FakeScreenshotBackoffScheduler";
import type { PerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { runWithSelectedDisplayPin } from "../../../src/features/observe/SessionDisplayContext";
import {
  resetObserveCacheStore,
  setObserveCacheStore,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";

const android = {
  deviceId: "target-display-android",
  platform: "android",
  name: "Android",
  displays: {
    panels: [
      { key: "internal", role: "inner", sizePx: { width: 100, height: 100 } },
      { key: "external", role: "external", sizePx: { width: 200, height: 200 } },
    ],
    postures: [],
  },
} as BootedDevice;

const ios = {
  ...android,
  deviceId: "target-display-ios",
  platform: "ios",
} as BootedDevice;

function screen(key: string, text = "Settings"): ObserveResult {
  return {
    observationId: `observe-${key}`,
    timestamp: 1,
    displayRevision: 0,
    display: {
      key,
      role: key === "external" ? "external" : "inner",
      posture: "unknown",
      generation: 1,
    },
    screenSize: { width: 200, height: 200 },
    rotation: 0,
    systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    viewHierarchy: {
      hierarchy: {
        node: { text, clickable: true, bounds: { left: 20, top: 30, right: 80, bottom: 90 } },
      },
      displayId: key === "external" ? 2 : 0,
      screenWidth: 200,
      screenHeight: 200,
    },
  } as ObserveResult;
}

function promotedLabelScreen(
  key: string,
  panel: { left: number; top: number; right: number; bottom: number },
  label: { left: number; top: number; right: number; bottom: number },
): ObserveResult {
  const observation = screen(key);
  observation.screenSize = { width: panel.right, height: panel.bottom };
  observation.viewHierarchy = {
    displayId: key === "external" ? 2 : 0,
    screenWidth: panel.right,
    screenHeight: panel.bottom,
    hierarchy: {
      bounds: { left: 0, top: 0, right: panel.right, bottom: panel.bottom },
      node: {
        $: { class: "android.view.View", bounds: panel, clickable: true },
        node: [
          { $: { class: "android.widget.TextView", text: "Network & internet", bounds: label } },
        ],
      },
    },
  };
  return observation;
}

function autoTimer(): FakeTimer {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
}

function focusScreen(focused: boolean): ObserveResult {
  const observation = screen("external", "");
  observation.viewHierarchy = {
    ...observation.viewHierarchy!,
    updatedAt: focused ? 2 : 1,
    hierarchy: {
      node: {
        class: "android.widget.EditText",
        "resource-id": "external-field",
        testTag: "external-field",
        editable: true,
        focused,
        bounds: { left: 20, top: 30, right: 80, bottom: 90 },
        node: {
          class: "android.widget.TextView",
          text: "Field",
          bounds: { left: 25, top: 35, right: 75, bottom: 45 },
        },
      },
    },
  };
  return observation;
}

function adb(): FakeAdbExecutor {
  const result = new FakeAdbExecutor();
  result.setCommandResponse("cmd display get-displays", {
    stdout:
      'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
    stderr: "",
  });
  return result;
}

// The default observe cache store persists every cached observation to the temp directory;
// keep these unit tests in memory so file IO is not charged to them.
beforeEach(() => setObserveCacheStore(new FakeObserveCacheStore()));
afterEach(() => resetObserveCacheStore());

describe("explicit action display", () => {
  let capabilitySpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    capabilitySpy = spyOn(AndroidCtrlProxyClient.prototype, "supportsCommand").mockResolvedValue(
      false,
    );
    displayTransitions.reset(android.deviceId);
    displayTransitions.reset(ios.deviceId);
  });

  afterEach(() => {
    capabilitySpy.mockRestore();
    DaemonState.getInstance().reset();
  });

  for (const kind of ["tapOn", "tapAt", "swipeOn", "dragAndDrop"] as const) {
    for (const outcome of [
      "changed",
      "unchanged",
      "empty",
      "unavailable",
      "throws",
      "throws-stale",
      "settle-throws",
      "settle-error",
      "settle-stale",
      "settle-transition",
      "dispatch-throws",
      "abort-post",
      "abort-post-return",
      "abort-settle",
    ] as const) {
      test(`${kind} targeted post-capture: ${outcome}`, async () => {
        const executor = adb();
        const timer = autoTimer();
        const before = screen("external", "Notifications");
        // An unrelated cached external panel must never become the baseline.
        const cached = screen("internal", "Other panel");
        const destination = screen(
          "external",
          outcome.startsWith("settle-") || outcome === "changed"
            ? "Notification history"
            : "Notifications",
        );
        if (outcome === "empty") {
          destination.viewHierarchy = undefined;
        }
        if (outcome === "unavailable") {
          destination.viewHierarchy = { hierarchy: { error: "service unavailable" } };
        }
        let dispatched = false;
        let invalidated = false;
        let postReads = 0;
        const controller = new AbortController();
        const calls: string[] = [];
        class PanelObserve extends FakeObserveScreen {
          override async getMostRecentCachedObserveResult(): Promise<ObserveResult> {
            calls.push("wrong-panel-cache");
            return cached;
          }
        }
        const observe = new PanelObserve();
        observe.setObserveResult(() => {
          calls.push(dispatched ? "post" : "pre");
          if (dispatched) {
            postReads++;
            if (outcome === "abort-post-return") {
              controller.abort();
              return { ...destination, viewHierarchy: undefined };
            }
            if (outcome === "abort-post" || (outcome === "abort-settle" && postReads > 1)) {
              controller.abort();
              throw new Error("cancelled post-capture");
            }
            if (outcome === "throws-stale") {
              throw new StaleDisplayError({
                observedGeneration: 1,
                currentGeneration: 2,
                retry: "observe",
              });
            }
            if (outcome === "throws" || (outcome === "settle-throws" && postReads > 1)) {
              throw new Error("post-capture unavailable");
            }
            if (postReads > 1 && outcome === "settle-transition") {
              displayTransitions.notifyTransition(android.deviceId, "fold");
              throw new StaleDisplayError({
                observedGeneration: 1,
                currentGeneration: 2,
                retry: "observe",
              });
            }
            if (postReads > 1 && outcome === "settle-error") {
              return {
                ...destination,
                viewHierarchy: { hierarchy: { error: "settle unavailable" } },
              };
            }
            if (postReads > 1 && outcome === "settle-stale") {
              return { ...screen("external", "Stale"), freshness: { isFresh: false } };
            }
          }
          const observation = invalidated ? destination : before;
          return {
            ...observation,
            viewHierarchy: observation.viewHierarchy
              ? { ...observation.viewHierarchy, updatedAt: 1_800_000_000_000 + calls.length }
              : undefined,
          };
        });
        const deps = { timer, lastRenderedObservation: () => before };
        const action =
          kind === "tapOn"
            ? new TapOnElement(android, executor, deps)
            : kind === "tapAt"
              ? new TapAtCoordinate(android, executor, deps)
              : kind === "swipeOn"
                ? new SwipeOn(android, executor as unknown as AdbClient, {
                    ...deps,
                    observeScreen: observe,
                  })
                : new DragAndDrop(android, executor as unknown as AdbClient, timer, deps);
        action.observeScreen = observe;
        const client = AndroidCtrlProxyClient.getExistingInstance(android.deviceId)!;
        const invalidate = spyOn(client, "invalidateCache").mockImplementation(() => {
          calls.push("invalidate");
          invalidated = true;
        });
        const executeCommand = executor.executeCommand.bind(executor);
        const dispatch = spyOn(executor, "executeCommand").mockImplementation(async (...args) => {
          if (args[0].includes("touchscreen")) {
            calls.push("dispatch");
            if (outcome === "dispatch-throws") {
              throw new Error("dispatch unavailable");
            }
            dispatched = true;
          }
          return executeCommand(...args);
        });
        try {
          const pending =
            action instanceof TapOnElement
              ? action.execute(
                  { action: "tap", text: "Notifications", display: "external" },
                  undefined,
                  controller.signal,
                )
              : action instanceof TapAtCoordinate
                ? action.execute(
                    { x: 40, y: 50, display: "external" },
                    undefined,
                    controller.signal,
                  )
                : action instanceof SwipeOn
                  ? action.execute(
                      { direction: "up", display: "external" },
                      undefined,
                      controller.signal,
                    )
                  : action.execute(
                      {
                        source: { text: "Notifications" },
                        target: { text: "Notifications" },
                        display: "external",
                      },
                      undefined,
                      controller.signal,
                    );
          if (outcome.startsWith("abort-")) {
            await expect(pending).rejects.toThrow("Operation cancelled");
            return;
          }
          const result = await pending;
          if (outcome === "dispatch-throws") {
            expect(result.success).toBe(false);
            expect(result.error).toContain("dispatch unavailable");
            expect(result.error).not.toContain("Do not retry automatically");
            expect(result.observation).toBeUndefined();
            expect(calls).toEqual(["pre", "dispatch"]);
            return;
          }
          expect(calls.slice(0, 4)).toEqual(["pre", "dispatch", "invalidate", "post"]);
          expect(calls).not.toContain("wrong-panel-cache");
          expect(
            observe.getExecuteOptions().every((options) => options.display === "external"),
          ).toBe(true);
          const postOptions = observe.getExecuteOptions().slice(1);
          expect(postOptions.every((options) => options.freshness === "fresh")).toBe(true);
          if (outcome === "throws" || outcome === "throws-stale") {
            expect(result.success).toBe(false);
            if (outcome === "throws-stale") {
              expect(result.staleDisplay).toMatchObject({
                observedGeneration: 1,
                currentGeneration: 2,
                retry: "observe",
              });
            } else {
              expect(result.error).toContain("post-capture unavailable");
            }
            expect(result.error).toContain("gesture was dispatched");
            expect(result.error).toContain("Do not retry automatically");
            if (kind === "tapAt") {
              expect(result.error).toContain("1 tap was delivered");
            }
            expect(result.observation).toBeUndefined();
          } else {
            expect(result.success).toBe(true);
            expect(result.observation?.viewHierarchy?.hierarchy).toEqual(
              destination.viewHierarchy?.hierarchy,
            );
            expect(result.effect?.screenChanged).toBe(
              outcome === "changed" || outcome === "unavailable" || outcome.startsWith("settle-"),
            );
            if (outcome.startsWith("settle-")) {
              expect(result.observation?.settled).toBe(false);
              expect(result.observation?.freshness?.warning).toContain("display settle");
              if (outcome === "settle-transition" || outcome === "settle-stale") {
                expect(result.staleDisplay?.retry).toBe("observe");
              }
            }
            if (outcome === "empty") {
              expect(result.effect?.basis).toBe("insufficient observation data");
            }
            if (outcome === "changed" || outcome === "unchanged") {
              expect(timer.getSleepHistory().length).toBeGreaterThan(0);
              expect(
                postOptions.some((options) => (options.minTimestamp ?? 0) > 1_800_000_000_000),
              ).toBe(true);
            }
          }
        } finally {
          invalidate.mockRestore();
          dispatch.mockRestore();
        }
      });
    }
  }

  test("display tap returns the destination instead of the pre-tap cache and includes effect", async () => {
    const executor = adb();
    const timer = autoTimer();
    timer.enableAutoAdvance();
    const before = screen("internal", "Notifications");
    const after = screen("internal", "Notification history");
    before.activeWindow = {
      appId: "com.android.settings",
      activityName: "Settings",
      layoutSeqSum: 0,
    };
    after.activeWindow = {
      appId: "com.android.settings",
      activityName: "Notifications",
      layoutSeqSum: 0,
    };
    let invalidated = false;
    let dispatched = false;
    const calls: string[] = [];
    const action = new TapOnElement(android, executor, {
      timer,
      lastRenderedObservation: () => before,
    });
    const client = AndroidCtrlProxyClient.getExistingInstance(android.deviceId)!;
    const invalidate = spyOn(client, "invalidateCache").mockImplementation(() => {
      calls.push("invalidate");
      invalidated = true;
    });
    const dispatch = spyOn(client, "requestTapCoordinates").mockImplementation(async () => {
      calls.push("dispatch");
      dispatched = true;
      return { success: true, totalTimeMs: 0 };
    });
    const observe = new FakeObserveScreen();
    observe.setObserveResult(() => {
      calls.push(dispatched ? "post" : "pre");
      const observation = invalidated ? after : before;
      return {
        ...observation,
        viewHierarchy: observation.viewHierarchy
          ? { ...observation.viewHierarchy, updatedAt: 1_800_000_000_000 + calls.length }
          : undefined,
      };
    });
    action.observeScreen = observe;
    try {
      const result = await action.execute({
        text: "Notifications",
        action: "tap",
        display: "inner",
      });
      expect(result.observation?.viewHierarchy?.hierarchy).toEqual(after.viewHierarchy?.hierarchy);
      expect(result.effect).toEqual({ screenChanged: true, basis: "activeWindow changed" });
      expect(calls.slice(0, 4)).toEqual(["pre", "dispatch", "invalidate", "post"]);
      expect(
        observe
          .getExecuteOptions()
          .every((options) => options.display === "internal" || options.display === "inner"),
      ).toBe(true);
    } finally {
      invalidate.mockRestore();
      dispatch.mockRestore();
    }
  });

  test("iOS targeted tapAt uses shared post-action handling on its live panel", async () => {
    const executor = adb();
    const timer = autoTimer();
    const before = screen("internal", "Notifications");
    const after = screen("internal", "Notification history");
    const calls: string[] = [];
    let dispatched = false;
    const client = {
      requestTapCoordinates: async () => {
        calls.push("dispatch");
        dispatched = true;
        return { success: true };
      },
    };
    const observe = new FakeObserveScreen();
    observe.setObserveResult(() => {
      calls.push(dispatched ? "post" : "pre");
      const observation = dispatched ? after : before;
      return {
        ...observation,
        viewHierarchy: {
          ...observation.viewHierarchy!,
          updatedAt: 1_800_000_000_000 + calls.length,
        },
      };
    });
    const action = new TapAtCoordinate(ios, executor, {
      timer,
      androidClient: client,
      iosClient: client,
      lastRenderedObservation: () => before,
      invalidateIosCache: () => calls.push("invalidate"),
    });
    action.observeScreen = observe;
    const result = await action.execute({ x: 40, y: 50, display: "inner" });
    expect(result.success).toBe(true);
    expect(result.effect?.screenChanged).toBe(true);
    expect(result.observation?.viewHierarchy?.hierarchy).toEqual(after.viewHierarchy?.hierarchy);
    expect(calls.slice(0, 4)).toEqual(["pre", "dispatch", "invalidate", "post"]);
    expect(
      observe
        .getExecuteOptions()
        .every((options) => options.display === "inner" || options.display === "internal"),
    ).toBe(true);
    expect(executor.getExecutedCommands()).toEqual([]);
  });

  test("flag-off observe records the rendered panel for the real session reader", async () => {
    const originalDiff = serverConfig.isActionsDiffObserveEnabled();
    const originalNoObserve = serverConfig.isActionsNoObserveEnabled();
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(createDevicePoolDependencies(manager, "display-test", { timer }));
    DaemonState.getInstance().initialize(manager, pool);
    const sessionId = "display-session";
    await manager.createSession(sessionId, android.deviceId, "android");
    const executor = adb();
    const observe = new FakeObserveScreen();
    observe.setObserveResult(screen("external"));
    const client = { requestTapCoordinates: async () => ({ success: true }) };
    const action = new TapAtCoordinate(android, executor, {
      timer: autoTimer(),
      androidClient: client,
      iosClient: client,
    });
    action.observeScreen = observe;
    try {
      serverConfig.setActionsDiffObserveEnabled(false);
      serverConfig.setActionsNoObserveEnabled(false);
      const before = await action.execute({ x: 40, y: 50, display: "external" });
      expect(before.success).toBe(false);
      expect(observe.getExecuteCallCount()).toBe(0);
      finalizeToolResponse(createStructuredToolResponse(screen("external")), {
        name: "observe",
        sessionUuid: sessionId,
        baselineStore: {
          get: (uuid) => manager.getLastRenderedObservation(uuid),
          set: (uuid, result, revision) =>
            manager.setLastRenderedObservation(uuid, result, revision),
          setDisplayRevision: (uuid, revision, key, generation) =>
            manager.setLastRenderedDisplayRevision(uuid, revision, key, generation),
        },
      });
      expect(sessionRenderedObservation(android.deviceId)?.display.key).toBe("external");
      expect(manager.getLastRenderedObservation(sessionId)).toBeUndefined();
      const after = await action.execute({ x: 40, y: 50, display: "external" });
      expect(after.success).toBe(true);
      expect(executor.getExecutedCommands()).toContain("shell input touchscreen -d 2 tap 40 50");
    } finally {
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
      serverConfig.setActionsNoObserveEnabled(originalNoObserve);
    }
  });

  test("other display actions consume the rendered session panel", async () => {
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "display-actions", { timer }),
    );
    DaemonState.getInstance().initialize(manager, pool);
    await manager.createSession("display-actions", android.deviceId, "android");
    manager.setLastRenderedDisplayRevision("display-actions", 0, "external");
    const fakeAdb = new FakeAdbClient();
    fakeAdb.setCommandResult(
      "shell cmd display get-displays",
      'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
    );
    const observe = new FakeObserveScreen();
    observe.setObserveResult(screen("external"));
    const swipe = new SwipeOn(android, fakeAdb as unknown as AdbClient, {
      timer: autoTimer(),
      observeScreen: observe,
      lastRenderedObservation: sessionRenderedObservation,
    });
    const signal = new AbortController().signal;
    expect(
      (await swipe.execute({ direction: "up", display: "external" }, undefined, signal)).success,
    ).toBe(true);
    expect(fakeAdb.getCommandCalls().at(-1)?.signal).toBe(signal);
    expect(observe.getExecuteOptions().at(-1)?.signal).toBe(signal);

    const drag = new DragAndDrop(android, fakeAdb as unknown as AdbClient, autoTimer(), {
      lastRenderedObservation: sessionRenderedObservation,
    });
    drag.observeScreen = observe;
    expect(
      (
        await drag.execute({
          source: { text: "Settings" },
          target: { text: "Settings" },
          display: "external",
        })
      ).success,
    ).toBe(true);

    const pinch = new PinchOn(android, fakeAdb as unknown as AdbClient, {
      timer: autoTimer(),
      lastRenderedObservation: sessionRenderedObservation,
    });
    pinch.observeScreen = observe;
    const pinchResult = await pinch.execute({ direction: "in", display: "external" });
    expect(pinchResult.error).toContain("CtrlProxy does not expose per-display pinch");

    const keyAdb = adb();
    const keys = new SendKeys(android, new FakeAdbClientFactory(keyAdb), {
      timer,
      observer: observe,
      timestampProvider: { now: async () => 1 },
      lastRenderedObservation: sessionRenderedObservation,
    });
    expect(
      (
        await keys.execute(
          [{ action: "key", key: "enter" }],
          undefined,
          undefined,
          undefined,
          "external",
        )
      ).success,
    ).toBe(true);
  });

  test("tapAt external injects on logical display 2", async () => {
    const executor = adb();
    const observation = screen("external");
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const client = { requestTapCoordinates: async () => ({ success: true }) };
    const action = new TapAtCoordinate(android, executor, {
      timer: autoTimer(),
      androidClient: client,
      iosClient: client,
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;
    const result = await action.execute({ x: 40, y: 50, display: "external" });
    expect(result.success).toBe(true);
    expect(executor.getExecutedCommands()).toContain("shell input touchscreen -d 2 tap 40 50");
    expect(observe.getExecuteOptions()[0]?.display).toBe("external");
  });

  test("tapAt without display keeps CtrlProxy dispatch and never probes displays", async () => {
    const executor = adb();
    const observe = new FakeObserveScreen();
    observe.setObserveResult(screen("internal"));
    const taps: Array<[number, number]> = [];
    const client = {
      requestTapCoordinates: async (x: number, y: number) => {
        taps.push([x, y]);
        return { success: true };
      },
    };
    const action = new TapAtCoordinate(android, executor, {
      timer: autoTimer(),
      androidClient: client,
      iosClient: client,
    });
    setFakeTapAtWindow(action);
    action.observeScreen = observe;
    const result = await action.execute({ x: 40, y: 50 });
    expect(result.success).toBe(true);
    expect(taps).toEqual([[40, 50]]);
    expect(executor.getExecutedCommands()).toEqual([]);
    expect(observe.getExecuteOptions().every((options) => options.display === undefined)).toBe(
      true,
    );
  });

  test("tapOn without display keeps CtrlProxy dispatch and never probes displays", async () => {
    const executor = adb();
    const observation = screen("internal");
    const taps: Array<[number, number]> = [];
    const ctrlProxy = {
      requestTapCoordinates: async (x: number, y: number) => {
        taps.push([x, y]);
        return { success: true };
      },
    };
    const instance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      ctrlProxy as unknown as AndroidCtrlProxyClient,
    );
    try {
      const action = new TapOnElement(android, executor, {
        timer: autoTimer(),
        tapStrategy: {
          isAccessibilityServiceEnabled: async () => false,
          shouldRunPreTapStability: () => false,
        } as never,
      });
      Object.assign(action, {
        observedInteraction: async (run: (observation: ObserveResult) => Promise<object>) => ({
          ...(await run(recordObservationRead(observation))),
          observation,
        }),
        prepareSelectionCapture: async () => null,
        deriveTapEffectAfterPostTapObservation: async () => ({ observation }),
        captureTerminalObservationScreenshot: async () => {},
        recordDeferredPredictionOutcome: async () => {},
        enforceFreshnessConsistencyWithEffect: () => {},
      });
      const result = await action.execute({ text: "Settings", action: "tap" });
      expect(result.success).toBe(true);
      expect(taps).toEqual([[50, 60]]);
      expect(executor.getExecutedCommands()).toEqual([]);
    } finally {
      instance.mockRestore();
    }
  });

  test("swipeOn without display keeps the gesture dispatch and never probes displays", async () => {
    const fakeAdb = new FakeAdbClient();
    const observation = screen("internal");
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const swipes: string[] = [];
    const action = new SwipeOn(android, fakeAdb as unknown as AdbClient, {
      timer: autoTimer(),
      observeScreen: observe,
    });
    Object.assign(action, {
      observedInteraction: async (run: (observation: ObserveResult) => Promise<object>) =>
        run(observation),
      talkBackExecutor: {
        executeSwipeGesture: async () => {
          swipes.push("legacy gesture");
          return { success: true, x1: 100, y1: 160, x2: 100, y2: 40, duration: 300 };
        },
      },
    });
    const result = await action.execute({ direction: "up", autoTarget: false });
    expect(result.success).toBe(true);
    expect(swipes).toEqual(["legacy gesture"]);
    expect(fakeAdb.getAllCommands()).toEqual([]);
    expect(observe.getExecuteOptions().every((options) => options.display === undefined)).toBe(
      true,
    );
  });

  test("dragAndDrop without display keeps CtrlProxy dispatch and never probes displays", async () => {
    const fakeAdb = new FakeAdbClient();
    const timer = autoTimer();
    timer.enableAutoAdvance();
    const drags: number[][] = [];
    const client = {
      requestDrag: async (...coordinates: number[]) => {
        drags.push(coordinates);
        return { success: true };
      },
    };
    const manager = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
      isAvailable: async () => true,
    } as never);
    const service = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      client as unknown as AndroidCtrlProxyClient,
    );
    try {
      const action = new DragAndDrop(android, fakeAdb as unknown as AdbClient, timer);
      Object.assign(action, {
        observedInteraction: async (run: (observation: ObserveResult) => Promise<object>) =>
          run(screen("internal")),
        resolveViewHierarchy: async () => screen("internal").viewHierarchy,
        resolveTarget: () => ({ bounds: { left: 20, top: 30, right: 80, bottom: 90 } }),
      });
      const result = await action.execute({
        source: { text: "Settings" },
        target: { text: "Settings" },
      });
      expect(result.success).toBe(true);
      expect(drags).toHaveLength(1);
      expect(fakeAdb.getAllCommands()).toEqual([]);
    } finally {
      service.mockRestore();
      manager.mockRestore();
    }
  });

  test("pinchOn without display keeps CtrlProxy dispatch and never probes displays", async () => {
    const fakeAdb = new FakeAdbClient();
    const pinches: number[][] = [];
    const client = {
      requestPinch: async (...coordinates: number[]) => {
        pinches.push(coordinates);
        return { success: true };
      },
    };
    const manager = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
      isAvailable: async () => true,
    } as never);
    const service = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      client as unknown as AndroidCtrlProxyClient,
    );
    try {
      const action = new PinchOn(android, fakeAdb as unknown as AdbClient);
      Object.assign(action, {
        observedInteraction: async (run: () => Promise<object>) => run(),
        resolveTarget: async () => ({
          bounds: { left: 0, top: 0, right: 200, bottom: 200 },
          targetType: "screen",
        }),
      });
      const result = await action.execute({ direction: "in" });
      expect(result.success).toBe(true);
      expect(pinches).toHaveLength(1);
      expect(fakeAdb.getAllCommands()).toEqual([]);
    } finally {
      service.mockRestore();
      manager.mockRestore();
    }
  });

  test("sendKeys without display keeps command dispatch and never probes displays", async () => {
    const executor = adb();
    const observe = new FakeObserveScreen();
    observe.setObserveResult(screen("internal"));
    const keys: string[] = [];
    const action = new SendKeys(android, new FakeAdbClientFactory(executor), {
      timer: autoTimer(),
      observer: observe,
      timestampProvider: { now: async () => 1 },
      executor: {
        type: async () => ({ index: 0, action: "type", success: true }),
        key: async (command) => {
          keys.push(command.key);
          return { index: 0, action: "key", success: true };
        },
        clear: async () => ({ success: true }),
      },
    });
    const result = await action.execute([{ action: "key", key: "enter" }]);
    expect(result.success).toBe(true);
    expect(keys).toEqual(["enter"]);
    expect(executor.getExecutedCommands()).toEqual([]);
    expect(observe.getExecuteOptions().at(-1)?.display).toBeUndefined();
  });

  test("tapOn resolves Settings from display 2 hierarchy", async () => {
    const executor = adb();
    const observation = screen("external");
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const action = new TapOnElement(android, executor, {
      timer: autoTimer(),
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;
    const result = await action.execute({ text: "Settings", action: "tap", display: "external" });
    expect(result.success).toBe(true);
    expect(executor.getExecutedCommands()).toContain("shell input touchscreen -d 2 tap 50 60");
  });

  test("tapOn reports input usage output as a failed display tap", async () => {
    const executor = adb();
    const observation = screen("external");
    executor.setCommandResponse("shell input touchscreen -d 2 tap 50 60", {
      stdout: "Unknown command: touchscreen",
      stderr: "",
    });
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const action = new TapOnElement(android, executor, {
      timer: autoTimer(),
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;

    const result = await action.execute({ text: "Settings", action: "tap", display: "external" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("input touchscreen -d 2 tap 50 60");
    expect(result.error).toContain("Unknown command: touchscreen");
  });

  test("swipeOn reports input usage output as a failed display swipe", async () => {
    const executor = adb();
    const observation = screen("external");
    executor.setCommandResponse("shell input touchscreen -d 2 swipe", {
      stdout: "Unknown command: touchscreen",
      stderr: "",
    });
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const action = new SwipeOn(android, executor as unknown as AdbClient, {
      timer: autoTimer(),
      observeScreen: observe,
      lastRenderedObservation: () => observation,
    });

    const result = await action.execute({ direction: "up", display: "external" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("input touchscreen -d 2 swipe");
    expect(result.error).toContain("Unknown command: touchscreen");
  });

  test("tapOn display taps the matched label within a promoted panel and reports the match", async () => {
    const executor = adb();
    const observation = promotedLabelScreen(
      "external",
      { left: 0, top: 0, right: 200, bottom: 200 },
      { left: 20, top: 30, right: 80, bottom: 50 },
    );
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const action = new TapOnElement(android, executor, {
      timer: autoTimer(),
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;

    const result = await action.execute({
      text: "Network & internet",
      action: "tap",
      display: "external",
    });

    expect(result.success).toBe(true);
    expect(executor.getExecutedCommands()).toContain("shell input touchscreen -d 2 tap 50 40");
    expect(result.selectedElement?.totalMatches).toBe(1);
  });

  test("tapOn display preserves non-zero hierarchy coordinates on logical display 2", async () => {
    const executor = adb();
    const observation = promotedLabelScreen(
      "external",
      { left: 100, top: 200, right: 300, bottom: 400 },
      { left: 140, top: 230, right: 180, bottom: 270 },
    );
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const action = new TapOnElement(android, executor, {
      timer: autoTimer(),
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;

    const result = await action.execute({
      text: "Network & internet",
      action: "tap",
      display: "external",
    });

    expect(result.success).toBe(true);
    expect(executor.getExecutedCommands()).toContain("shell input touchscreen -d 2 tap 160 250");
  });

  test("dragAndDrop display uses the matched source and target rather than their promoted panel", async () => {
    const fakeAdb = new FakeAdbClient();
    fakeAdb.setCommandResult(
      "shell cmd display get-displays",
      'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
    );
    const observation = promotedLabelScreen(
      "external",
      { left: 0, top: 0, right: 200, bottom: 200 },
      { left: 20, top: 30, right: 80, bottom: 50 },
    );
    const root = observation.viewHierarchy?.hierarchy.node;
    if (!root) {
      throw new Error("Expected hierarchy root");
    }
    root.node = [
      {
        $: {
          class: "android.widget.TextView",
          text: "Source",
          bounds: { left: 20, top: 30, right: 80, bottom: 50 },
        },
      },
      {
        $: {
          class: "android.widget.TextView",
          text: "Target",
          bounds: { left: 120, top: 130, right: 180, bottom: 150 },
        },
      },
    ];
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const action = new DragAndDrop(android, fakeAdb as unknown as AdbClient, autoTimer(), {
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;

    const result = await action.execute({
      source: { text: "Source" },
      target: { text: "Target" },
      display: "external",
    });

    expect(result.success).toBe(true);
    expect(fakeAdb.getAllCommands()).toContain(
      "shell input touchscreen -d 2 draganddrop 50 40 150 140 300",
    );
  });

  test("swipeOn display text container uses the same matched bounds as the default path", async () => {
    const fakeAdb = new FakeAdbClient();
    fakeAdb.setCommandResult(
      "shell cmd display get-displays",
      'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
    );
    const observation = promotedLabelScreen(
      "external",
      { left: 0, top: 0, right: 200, bottom: 200 },
      { left: 20, top: 30, right: 80, bottom: 90 },
    );
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const action = new SwipeOn(android, fakeAdb as unknown as AdbClient, {
      timer: autoTimer(),
      observeScreen: observe,
      lastRenderedObservation: () => observation,
    });

    const result = await action.execute({
      direction: "up",
      container: { text: "Network & internet" },
      display: "external",
    });

    expect(result.success).toBe(true);
    expect(fakeAdb.getAllCommands()).toContain(
      "shell input touchscreen -d 2 swipe 50 78 50 42 300",
    );

    const defaultCoordinates: number[] = [];
    const defaultAction = new SwipeOn(android, fakeAdb as unknown as AdbClient, {
      timer: autoTimer(),
      observeScreen: observe,
    });
    Object.assign(defaultAction, {
      observedInteraction: async (run: (current: ObserveResult) => Promise<object>) =>
        run(observation),
      talkBackExecutor: {
        executeSwipeGesture: async (x1: number, y1: number, x2: number, y2: number) => {
          defaultCoordinates.push(x1, y1, x2, y2);
          return { success: true, x1, y1, x2, y2, duration: 300 };
        },
      },
    });
    const defaultResult = await defaultAction.execute({
      direction: "up",
      container: { text: "Network & internet" },
    });
    expect(defaultResult.success).toBe(true);
    expect(defaultCoordinates).toEqual([50, 84, 50, 36]);
  });

  for (const [actionName, command] of [
    ["longPress", "shell input touchscreen -d 2 swipe 50 40 50 40 800"],
    ["doubleTap", "shell input touchscreen -d 2 tap 50 40"],
  ] as const) {
    test(`tapOn display ${actionName} uses the matched visible centre`, async () => {
      const executor = adb();
      const observation = promotedLabelScreen(
        "external",
        { left: 0, top: 0, right: 200, bottom: 200 },
        { left: 20, top: 30, right: 80, bottom: 50 },
      );
      const observe = new FakeObserveScreen();
      observe.setObserveResult(observation);
      const action = new TapOnElement(android, executor, {
        timer: autoTimer(),
        lastRenderedObservation: () => observation,
      });
      action.observeScreen = observe;

      const result = await action.execute({
        text: "Network & internet",
        action: actionName,
        display: "external",
      });

      expect(result.success).toBe(true);
      expect(
        executor.getExecutedCommands().filter((executed) => executed.includes("touchscreen")),
      ).toEqual(actionName === "doubleTap" ? [command, command] : [command]);
    });
  }

  for (const [caseName, label] of [
    ["outside the screen", { left: 220, top: 30, right: 280, bottom: 50 }],
    ["zero area", { left: 20, top: 30, right: 20, bottom: 50 }],
  ] as const) {
    test(`tapOn handles a matched label ${caseName} consistently with and without display`, async () => {
      const observation = promotedLabelScreen(
        "external",
        { left: 0, top: 0, right: 200, bottom: 200 },
        label,
      );
      const executor = adb();
      const observe = new FakeObserveScreen();
      observe.setObserveResult(observation);
      const capture = new FakeHierarchyCapture(() => observation.viewHierarchy!);
      const displayAction = new TapOnElement(android, executor, {
        timer: autoTimer(),
        hierarchyCapture: capture,
        lastRenderedObservation: () => observation,
      });
      displayAction.observeScreen = observe;
      const displayResult = await displayAction.execute({
        text: "Network & internet",
        action: "tap",
        display: "external",
      });
      expect(displayResult.success).toBe(caseName === "zero area");
      if (caseName === "outside the screen") {
        expect(displayResult.error).toBe(
          'Matched element "Network & internet" has no visible tap area (bounds {"left":220,"top":30,"right":280,"bottom":50}). Scroll it into view with swipeOn, then retry tapOn.',
        );
        expect(displayResult.searchUntil).toEqual({
          durationMs: 1450,
          requestCount: 30,
          changeCount: 0,
        });
        expect(capture.requests).toHaveLength(30);
        expect(
          capture.requests.every(
            (request) => request.displayId === 2 && request.freshness === "fresh",
          ),
        ).toBe(true);
        expect(
          executor.getExecutedCommands().filter((command) => command.includes("touchscreen tap")),
        ).toEqual([]);
      } else {
        expect(capture.requests).toEqual([]);
        expect(executor.getExecutedCommands()).toContain(
          "shell input touchscreen -d 2 tap 100 100",
        );
      }

      const timer = autoTimer();
      timer.enableAutoAdvance();
      const defaultAction = new TapOnElement(android, adb(), { timer });
      const defaultPoints: Array<{ x: number; y: number }> = [];
      defaultAction.observedInteraction = async (run) => ({
        ...(await run(observation)),
        observation,
      });
      defaultAction.refreshViewHierarchy = async () => observation.viewHierarchy;
      defaultAction.executeAndroidTap = async (_action, x, y) => {
        defaultPoints.push({ x, y });
      };
      defaultAction.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
        observation: current,
      });
      defaultAction.captureTerminalObservationScreenshot = async () => {};
      defaultAction.recordDeferredPredictionOutcome = async () => {};
      defaultAction.enforceFreshnessConsistencyWithEffect = () => {};
      const defaultResult = await defaultAction.execute({
        text: "Network & internet",
        action: "tap",
      });
      expect(defaultResult.success).toBe(caseName === "zero area");
      if (caseName === "outside the screen") {
        expect(defaultResult.error).toBe(
          `Failed to perform tap on element: ${displayResult.error}`,
        );
        expect(defaultPoints).toEqual([]);
      } else {
        expect(defaultPoints).toEqual([{ x: 100, y: 100 }]);
      }
    });
  }

  test("tapOn reports a missing target on the selected display", async () => {
    const executor = adb();
    const observation = screen("external", "Settings");
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const capture = new FakeHierarchyCapture(() => observation.viewHierarchy!);
    const action = new TapOnElement(android, executor, {
      timer: autoTimer(),
      hierarchyCapture: capture,
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;
    const result = await action.execute({ text: "Other app", action: "tap", display: "external" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Element not found with provided text 'Other app'");
    expect(result.searchUntil).toEqual({ durationMs: 1450, requestCount: 30, changeCount: 0 });
    expect(capture.requests).toHaveLength(30);
    expect(
      capture.requests.every((request) => request.displayId === 2 && request.freshness === "fresh"),
    ).toBe(true);
    expect(
      executor.getExecutedCommands().filter((command) => command.includes("touchscreen")),
    ).toEqual([]);
  });

  for (const extra of [
    { focusFirst: true },
    { subtext: { text: "Link" } },
    { accessibilityLink: "Link" },
  ] satisfies Array<Partial<TapOnElementOptions>>) {
    for (const route of [
      "sole pin",
      "other panel pin",
      "explicit display",
      "nested explicit display",
      "no pin",
    ] as const) {
      test(`session pin options: tapOn ${Object.keys(extra)[0]} with ${route}`, async () => {
        const target: BootedDevice =
          route === "sole pin"
            ? {
                ...android,
                displays: { panels: android.displays!.panels.slice(0, 1), postures: [] },
              }
            : android;
        const observation = screen("internal");
        observation.viewHierarchy!.hierarchy = {
          node: {
            text: "Settings",
            "resource-id": "owner",
            clickable: true,
            bounds: "[20,30][80,90]",
          },
        };
        const ctrl = new FakeCtrlProxy();
        const client = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
          // @ts-expect-error -- Fake supplies the client methods exercised by this test.
          ctrl,
        );
        const action = new TapOnElement(target, adb(), {
          timer: autoTimer(),
          tapStrategy: new FakeTapStrategy(),
          accessibilityDetector: new FakeAccessibilityDetector(),
          selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
          hierarchyCapture: new FakeHierarchyCapture(() => observation.viewHierarchy!),
        });
        const observe = new FakeObserveScreen();
        observe.setObserveResult(observation);
        action.observeScreen = observe;
        const tap = spyOn(action, "executeAndroidTap").mockResolvedValue(undefined);
        const capture = spyOn(action, "prepareSelectionCapture").mockResolvedValue(null);
        const link = spyOn(ctrl, "requestActivateAccessibilityLink");
        action.observedInteraction = async (run) => ({ ...(await run(observation)), observation });
        const explicit = route.includes("explicit");
        const pin = route === "sole pin" ? "internal" : "external";
        try {
          const run = () =>
            runSessionDisplayPin({
              name: "tapOn",
              acceptsDisplay: true,
              device: target,
              sessionUuid: "s1",
              store: {
                getDeviceForSession: () => target.deviceId,
                getDisplayPin: () => (route === "no pin" ? undefined : pin),
              },
              args: explicit ? { display: "external" } : {},
              invoke: (args) =>
                action.execute({
                  action: "tap",
                  ...(extra.accessibilityLink ? {} : { text: "Settings" }),
                  ...extra,
                  display: typeof args.display === "string" ? args.display : undefined,
                }),
            });
          const result = await (route === "nested explicit display"
            ? runWithSelectedDisplayPin({ pin, inventory: target.displays }, run)
            : run());
          if (route === "sole pin" || route === "no pin") {
            expect(result).toMatchObject({ success: true });
            expect(extra.focusFirst ? tap : link).toHaveBeenCalledTimes(1);
          } else {
            expect(result).toMatchObject({
              success: false,
              error: explicit
                ? `${Object.keys(extra)[0]} is not supported with \`display\` yet`
                : `${Object.keys(extra)[0]} is not supported while the session is pinned to display "external". Clear the pin with setActiveDevice {display: null} (include deviceId and sessionUuid), then retry.`,
            });
            expect(tap).not.toHaveBeenCalled();
            expect(link).not.toHaveBeenCalled();
          }
        } finally {
          tap.mockRestore();
          capture.mockRestore();
          link.mockRestore();
          client.mockRestore();
        }
      });
    }
  }

  test("tapOn rejects display options it cannot honor before dispatch", async () => {
    const unsupported: Array<Partial<TapOnElementOptions>> = [
      { subtext: { text: "Link" } },
      { accessibilityLink: "Link" },
      { focusFirst: true },
      { screenReaderNavigation: true },
    ];
    const executor = adb();
    const observe = new FakeObserveScreen();
    const action = new TapOnElement(android, executor, { timer: autoTimer() });
    action.observeScreen = observe;
    for (const extra of unsupported) {
      const result = await action.execute({
        text: "Settings",
        action: "tap",
        display: "external",
        ...extra,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported with `display` yet");
    }
    expect(executor.getExecutedCommands()).toEqual([]);
    expect(observe.getExecuteCallCount()).toBe(0);
  });

  test("swipeOn rejects every unsupported display option without claiming search success", async () => {
    const unsupported: Array<Partial<SwipeOnOptions>> = [{ focusTarget: true }];
    const observe = new FakeObserveScreen();
    const fakeAdb = new FakeAdbClient();
    const action = new SwipeOn(android, fakeAdb as unknown as AdbClient, {
      timer: autoTimer(),
      observeScreen: observe,
    });
    for (const extra of unsupported) {
      const result = await action.execute({ direction: "up", display: "external", ...extra });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported with `display` yet");
    }
    expect(observe.getExecuteCallCount()).toBe(0);
    expect(fakeAdb.getAllCommands()).toEqual([]);
  });

  test("coordinates observed on display 0 cannot target external", async () => {
    const executor = adb();
    const observe = new FakeObserveScreen();
    observe.setObserveResult(screen("external"));
    const client = { requestTapCoordinates: async () => ({ success: true }) };
    const action = new TapAtCoordinate(android, executor, {
      timer: autoTimer(),
      androidClient: client,
      iosClient: client,
      lastRenderedObservation: () => screen("internal"),
    });
    action.observeScreen = observe;
    const result = await action.execute({ x: 40, y: 50, display: "external" });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Re-observe display "external"');
    expect(observe.getExecuteCallCount()).toBe(0);
  });

  test("iOS rejects a non-live panel", async () => {
    const executor = adb();
    const observe = new FakeObserveScreen();
    observe.setFailureMode(
      "execute",
      new Error('Display "external" is not the active panel on iOS. Active panel: internal'),
    );
    const client = { requestTapCoordinates: async () => ({ success: true }) };
    const action = new TapAtCoordinate(ios, executor, {
      timer: autoTimer(),
      androidClient: client,
      iosClient: client,
      lastRenderedObservation: () => screen("internal"),
    });
    action.observeScreen = observe;
    const result = await action.execute({ x: 40, y: 50, display: "external" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not the active panel on iOS");
  });

  test("rejects an old display revision before dispatch", async () => {
    const executor = adb();
    const observation = screen("external");
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    displayTransitions.notifyTransition(android.deviceId, "panel changed");
    const client = { requestTapCoordinates: async () => ({ success: true }) };
    const action = new TapAtCoordinate(android, executor, {
      timer: autoTimer(),
      androidClient: client,
      iosClient: client,
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;
    const result = await action.execute({ x: 40, y: 50, display: "external" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("observed generation 1, current generation 1");
    expect(result.error).toContain("Re-observe the active panel");
    expect(result.staleDisplay).toEqual({
      observedGeneration: 1,
      currentGeneration: 1,
      retry: "observe",
    });
    expect(executor.getExecutedCommands()).toEqual([]);
  });

  test("sendKeys discrete key routes to display 2 and observes it afterward", async () => {
    const executor = adb();
    const observation = screen("external");
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const action = new SendKeys(android, new FakeAdbClientFactory(executor), {
      timer: autoTimer(),
      observer: observe,
      timestampProvider: { now: async () => 1 },
      lastRenderedObservation: () => observation,
    });
    const result = await action.execute(
      [{ action: "key", key: "enter" }],
      undefined,
      undefined,
      undefined,
      "external",
    );
    expect(result.success).toBe(true);
    expect(executor.getExecutedArgv()).toContainEqual([
      "shell",
      "input",
      "-d",
      "2",
      "keyevent",
      "KEYCODE_ENTER",
    ]);
    expect(observe.getExecuteOptions().at(-1)?.display).toBe("external");
  });

  for (const route of ["CtrlProxy", "adb"] as const) {
    for (const outcome of [
      "confirmed",
      "non-editable",
      "already-focused",
      "unconfirmed",
      "stale",
    ] as const) {
      test(`tapOn display focus ${route}: ${outcome}`, async () => {
        const executor = adb();
        const before =
          outcome === "non-editable"
            ? screen("external", "Field")
            : focusScreen(outcome === "already-focused");
        const after = focusScreen(outcome !== "unconfirmed");
        let dispatched = false;
        const observe = new FakeObserveScreen();
        observe.setObserveResult(() => (dispatched ? after : before));
        const action = new TapOnElement(android, executor, {
          timer: autoTimer(),
          lastRenderedObservation: () => before,
        });
        action.observeScreen = observe;
        const client = AndroidCtrlProxyClient.getExistingInstance(android.deviceId)!;
        const capability = spyOn(client, "supportsCommand").mockImplementation(async () => {
          if (outcome === "stale") {
            displayTransitions.notifyTransition(android.deviceId, "panel changed before focus");
          }
          return route === "CtrlProxy";
        });
        const tap = spyOn(client, "requestTapCoordinates").mockImplementation(async () => {
          dispatched = true;
          return { success: true, totalTimeMs: 0 };
        });
        const executeCommand = executor.executeCommand.bind(executor);
        const input = spyOn(executor, "executeCommand").mockImplementation(async (...args) => {
          if (args[0].includes("touchscreen")) {
            dispatched = true;
          }
          return executeCommand(...args);
        });
        try {
          const result = await action.execute({
            text: "Field",
            action: "focus",
            display: "external",
          });
          const commands = executor
            .getExecutedCommands()
            .filter((command) => command.includes("touchscreen"));
          if (outcome === "confirmed" || outcome === "already-focused") {
            expect(result.success).toBe(true);
            expect(result.action).toBe("focus");
            expect(result.focusVerified).toBe(true);
            expect(result.element?.["resource-id"]).toBe("external-field");
          } else {
            expect(result.success).toBe(false);
            if (outcome === "non-editable") {
              expect(result.error).toBe('Cannot focus "Field" because it is not an editable input');
            } else if (outcome === "unconfirmed") {
              expect(result.error).toContain("Failed to confirm focus on editable input");
              expect(result.focusVerified).toBe(false);
            } else {
              expect(result.error).toContain("Re-observe the active panel");
              expect(result.staleDisplay?.retry).toBe("observe");
            }
          }
          if (outcome === "already-focused") {
            expect(result.wasAlreadyFocused).toBe(true);
            expect(result.focusChanged).toBe(false);
          }
          if (outcome === "confirmed" || outcome === "unconfirmed") {
            if (route === "CtrlProxy") {
              expect(tap).toHaveBeenCalledTimes(1);
              expect(tap.mock.calls[0].slice(0, 2)).toEqual([50, 60]);
              expect(tap.mock.calls[0].at(-2)).toBe(2);
              expect(tap.mock.calls[0].at(-1)).toBeFunction();
              expect(commands).toEqual([]);
            } else {
              expect(tap).not.toHaveBeenCalled();
              expect(commands).toEqual(["shell input touchscreen -d 2 tap 50 60"]);
            }
            expect(result.observation?.viewHierarchy?.hierarchy).toEqual(
              after.viewHierarchy?.hierarchy,
            );
            expect(observe.getExecuteOptions().at(-1)).toMatchObject({
              display: "external",
              freshness: "fresh",
            });
          } else {
            expect(tap).not.toHaveBeenCalled();
            expect(commands).toEqual([]);
          }
        } finally {
          input.mockRestore();
          tap.mockRestore();
          capability.mockRestore();
        }
      });
    }
  }

  test("sendKeys real focuser types, clears and sends IME keys on the selected display", async () => {
    const executor = adb();
    const before = focusScreen(false);
    const after = focusScreen(true);
    let dispatched = false;
    const observe = new FakeObserveScreen();
    observe.setObserveResult(() => (dispatched ? after : before));
    // Keep the real default focuser, selector, dispatch and observation wrapper.
    // Only its device observation boundary is replaced with the existing fake.
    const capture = spyOn(RealObserveScreen.prototype, "execute").mockImplementation((options) =>
      observe.execute(options),
    );
    const screenshot = spyOn(RealObserveScreen.prototype, "captureScreenshot").mockResolvedValue();
    const audit = spyOn(RealObserveScreen.prototype, "runAccessibilityAudit").mockResolvedValue();
    const tap = spyOn(AndroidCtrlProxyClient.prototype, "requestTapCoordinates").mockImplementation(
      async () => {
        dispatched = true;
        return { success: true, totalTimeMs: 0 };
      },
    );
    capabilitySpy.mockResolvedValue(true);
    const typed: string[] = [];
    const executed: string[] = [];
    const action = new SendKeys(android, new FakeAdbClientFactory(executor), {
      timer: autoTimer(),
      observer: observe,
      timestampProvider: { now: async () => 1 },
      lastRenderedObservation: () => before,
      executor: {
        type: async (command) => {
          typed.push(command.text);
          executed.push("type");
          return { index: 0, action: "type", success: true };
        },
        key: async (command) => {
          executed.push(`key:${command.key}`);
          return { index: 0, action: "key", success: true };
        },
        clear: async () => {
          executed.push("clear");
          return { success: true };
        },
      },
    });
    try {
      const result = await action.execute(
        [{ action: "type", text: "hello" }, { action: "clear" }, { action: "key", key: "done" }],
        { text: "Field" },
        undefined,
        undefined,
        "external",
      );
      expect(result.success).toBe(true);
      expect(tap).toHaveBeenCalledTimes(1);
      expect(tap.mock.calls[0].at(-2)).toBe(2);
      expect(typed).toEqual(["hello"]);
      expect(executed).toEqual(["type", "clear", "key:done"]);
      expect(observe.getExecuteOptions().at(-1)?.display).toBe("external");
      expect(result.observation?.viewHierarchy?.hierarchy).toEqual(after.viewHierarchy?.hierarchy);
    } finally {
      tap.mockRestore();
      audit.mockRestore();
      screenshot.mockRestore();
      capture.mockRestore();
    }
  });

  test("sendKeys text focuses a field on the selected display", async () => {
    const executor = adb();
    const observation = screen("external");
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const focused: string[] = [];
    const typed: string[] = [];
    const action = new SendKeys(android, new FakeAdbClientFactory(executor), {
      timer: autoTimer(),
      observer: observe,
      timestampProvider: { now: async () => 1 },
      lastRenderedObservation: () => observation,
      focuser: {
        focus: async (_selector, _signal, display) => {
          focused.push(display ?? "default");
          return { success: true };
        },
      },
      executor: {
        type: async (command) => {
          typed.push(command.text);
          return { index: 0, action: "type", success: true };
        },
        key: async () => ({ index: 0, action: "key", success: true }),
        clear: async () => ({ success: true }),
      },
    });
    const result = await action.execute(
      [{ action: "type", text: "hello" }],
      { text: "Field" },
      undefined,
      undefined,
      "external",
    );
    expect(result.success).toBe(true);
    expect(focused).toEqual(["external"]);
    expect(typed).toEqual(["hello"]);
    expect(observe.getExecuteOptions().at(-1)?.display).toBe("external");
  });
});

describe("CtrlProxy display-targeted action routing", () => {
  for (const kind of ["tapOn", "tapAt", "swipeOn", "dragAndDrop"] as const) {
    test(`${kind} CtrlProxy dispatch returns a fresh targeted observation and effect`, async () => {
      displayTransitions.reset(android.deviceId);
      const executor = adb();
      const timer = autoTimer();
      const controller = new AbortController();
      const before = screen("external", "Notifications");
      const after = screen("external", "Notification history");
      const calls: string[] = [];
      let dispatched = false;
      let invalidated = false;
      const observe = new FakeObserveScreen();
      observe.setObserveResult(() => {
        calls.push(dispatched ? "post" : "pre");
        const observation = invalidated ? after : before;
        return {
          ...observation,
          viewHierarchy: {
            ...observation.viewHierarchy!,
            updatedAt: 1_800_000_000_000 + calls.length,
          },
        };
      });
      const deps = { timer, lastRenderedObservation: () => before };
      const action =
        kind === "tapOn"
          ? new TapOnElement(android, executor, deps)
          : kind === "tapAt"
            ? new TapAtCoordinate(android, executor, deps)
            : kind === "swipeOn"
              ? new SwipeOn(android, executor as unknown as AdbClient, {
                  ...deps,
                  observeScreen: observe,
                })
              : new DragAndDrop(android, executor as unknown as AdbClient, timer, deps);
      action.observeScreen = observe;
      const client = AndroidCtrlProxyClient.getExistingInstance(android.deviceId)!;
      const capability = spyOn(client, "supportsCommand").mockResolvedValue(true);
      const invalidate = spyOn(client, "invalidateCache").mockImplementation(() => {
        calls.push("invalidate");
        invalidated = true;
      });
      const dispatchResult = async () => {
        calls.push("dispatch");
        dispatched = true;
        return { success: true, totalTimeMs: 0 };
      };
      const tap = spyOn(client, "requestTapCoordinates").mockImplementation(dispatchResult);
      const swipe = spyOn(client, "requestSwipe").mockImplementation(dispatchResult);
      const drag = spyOn(client, "requestDrag").mockImplementation(dispatchResult);
      try {
        const result =
          action instanceof TapOnElement
            ? await action.execute(
                { text: "Notifications", display: "external" },
                undefined,
                controller.signal,
              )
            : action instanceof TapAtCoordinate
              ? await action.execute(
                  { x: 40, y: 50, display: "external" },
                  undefined,
                  controller.signal,
                )
              : action instanceof SwipeOn
                ? await action.execute(
                    { direction: "up", display: "external" },
                    undefined,
                    controller.signal,
                  )
                : await action.execute(
                    {
                      source: { text: "Notifications" },
                      target: { text: "Notifications" },
                      display: "external",
                    },
                    undefined,
                    controller.signal,
                  );
        expect(result.success).toBe(true);
        expect(result.observation?.display.key).toBe("external");
        expect(result.observation?.viewHierarchy?.hierarchy).toEqual(
          after.viewHierarchy?.hierarchy,
        );
        expect(result.effect?.screenChanged).toBe(true);
        expect(calls.slice(0, 4)).toEqual(["pre", "dispatch", "invalidate", "post"]);
        const requests = [...tap.mock.calls, ...swipe.mock.calls, ...drag.mock.calls];
        expect(requests).toHaveLength(1);
        expect(requests[0].at(kind === "dragAndDrop" ? -4 : -3)).toBe(controller.signal);
        expect(requests[0].at(kind === "dragAndDrop" ? -3 : -2)).toBe(2);
        expect(requests[0].at(kind === "dragAndDrop" ? -2 : -1)).toBeFunction();
        expect(
          executor.getExecutedCommands().filter((cmd) => cmd.startsWith("shell input")),
        ).toEqual([]);
        const postOptions = observe.getExecuteOptions().slice(1);
        expect(postOptions.length).toBeGreaterThan(0);
        expect(
          postOptions.every(
            (options) =>
              options.display === "external" &&
              options.freshness === "fresh" &&
              options.signal === controller.signal,
          ),
        ).toBe(true);
        expect(timer.getSleepHistory().length).toBeGreaterThan(0);
        expect(postOptions.some((options) => (options.minTimestamp ?? 0) > 1_800_000_000_000)).toBe(
          true,
        );
      } finally {
        for (const spy of [capability, invalidate, tap, swipe, drag]) {
          spy.mockRestore();
        }
        displayTransitions.reset(android.deviceId);
      }
    });
  }

  const gestures = [
    "tapAt",
    "longPressAt",
    "tapOn",
    "longPressOn",
    "doubleTapOn",
    "swipe",
    "drag",
    "pinch",
  ] as const;
  for (const gesture of gestures) {
    for (const flag of [false, true]) {
      for (const panel of ["internal", "external"]) {
        for (const failure of flag && panel === "external" ? [false, true] : [false]) {
          test(`${gesture}: flag=${flag}, panel=${panel}, serviceFailure=${failure}`, async () => {
            displayTransitions.reset(android.deviceId);
            const observation = screen(panel);
            const observe = new FakeObserveScreen();
            observe.setObserveResult(observation);
            const executor = adb();
            const timer = new FakeTimer();
            timer.enableAutoAdvance();
            const response = {
              success: !failure,
              totalTimeMs: 0,
              ...(failure ? { error: "Display 2 dispatch is unavailable on this API" } : {}),
            };
            const commands = spyOn(
              AndroidCtrlProxyClient.prototype,
              "supportsCommand",
            ).mockResolvedValue(flag);
            const tap = spyOn(
              AndroidCtrlProxyClient.prototype,
              "requestTapCoordinates",
            ).mockResolvedValue(response);
            const swipe = spyOn(AndroidCtrlProxyClient.prototype, "requestSwipe").mockResolvedValue(
              response,
            );
            const drag = spyOn(AndroidCtrlProxyClient.prototype, "requestDrag").mockResolvedValue(
              response,
            );
            const pinch = spyOn(AndroidCtrlProxyClient.prototype, "requestPinch").mockResolvedValue(
              response,
            );
            // The real method opens a localhost WebSocket (a host emulator's adb forward can answer
            // it), so keep the sequential two-tap path under test deterministic and off the network.
            const doubleTap = spyOn(
              AndroidCtrlProxyClient.prototype,
              "requestDoubleTapCoordinates",
            ).mockResolvedValue({
              success: false,
              totalTimeMs: 0,
              error: "tap_double_v1 is not confirmed by the connected device service",
            });
            const manager = spyOn(
              AndroidCtrlProxyManager.prototype,
              "isAvailable",
            ).mockResolvedValue(true);
            const controller = new AbortController();
            const deps = { timer, lastRenderedObservation: () => observation };
            try {
              let result: { success: boolean; error?: string };
              if (gesture === "tapAt" || gesture === "longPressAt") {
                const action = new TapAtCoordinate(android, executor, deps);
                action.observeScreen = observe;
                result = await action.execute(
                  {
                    x: 40,
                    y: 50,
                    display: panel,
                    action: gesture === "longPressAt" ? "longPress" : "tap",
                  },
                  undefined,
                  controller.signal,
                );
              } else if (
                gesture === "tapOn" ||
                gesture === "longPressOn" ||
                gesture === "doubleTapOn"
              ) {
                const action = new TapOnElement(android, executor as unknown as AdbClient, deps);
                action.observeScreen = observe;
                result = await action.execute(
                  {
                    text: "Settings",
                    display: panel,
                    action:
                      gesture === "longPressOn"
                        ? "longPress"
                        : gesture === "doubleTapOn"
                          ? "doubleTap"
                          : "tap",
                  },
                  undefined,
                  controller.signal,
                );
              } else if (gesture === "swipe") {
                const action = new SwipeOn(android, executor as unknown as AdbClient, {
                  ...deps,
                  observeScreen: observe,
                });
                result = await action.execute(
                  { direction: "up", display: panel },
                  undefined,
                  controller.signal,
                );
              } else if (gesture === "drag") {
                const action = new DragAndDrop(
                  android,
                  executor as unknown as AdbClient,
                  timer,
                  deps,
                );
                action.observeScreen = observe;
                result = await action.execute(
                  {
                    source: { text: "Settings" },
                    target: { text: "Settings" },
                    display: panel,
                  },
                  undefined,
                  controller.signal,
                );
              } else {
                const action = new PinchOn(android, executor as unknown as AdbClient, deps);
                action.observeScreen = observe;
                Object.assign(action, {
                  observedInteraction: async (run: () => Promise<object>) => run(),
                });
                result = await action.execute(
                  {
                    direction: "in",
                    display: panel,
                    autoTarget: false,
                  },
                  undefined,
                  controller.signal,
                );
              }
              const calls = [
                ...tap.mock.calls,
                ...swipe.mock.calls,
                ...drag.mock.calls,
                ...pinch.mock.calls,
              ];
              const inputs = executor
                .getExecutedCommands()
                .filter((command) => command.startsWith("shell input"));
              if (flag || panel === "internal") {
                const fallsBack =
                  failure &&
                  (gesture === "tapAt" ||
                    gesture === "longPressAt" ||
                    gesture === "tapOn" ||
                    gesture === "longPressOn" ||
                    gesture === "doubleTapOn");
                expect(result.success).toBe(!failure || fallsBack);
                if (failure && !fallsBack) {
                  expect(result.error).toContain(response.error!);
                }
                expect(calls).toHaveLength(
                  gesture === "doubleTapOn" && (!failure || fallsBack) ? 2 : 1,
                );
                expect(calls[0].at(gesture === "drag" ? -3 : -2)).toBe(
                  panel === "external" ? 2 : undefined,
                );
                expect(calls[0].at(gesture === "drag" ? -2 : -1)).toBeFunction();
                if (panel === "external") {
                  expect(calls[0].at(gesture === "drag" ? -4 : -3)).toBe(controller.signal);
                }
                expect(inputs).toEqual(
                  fallsBack
                    ? tap.mock.calls.map(
                        ([x, y, duration]) =>
                          `shell input touchscreen -d 2 ${
                            gesture === "longPressAt" || gesture === "longPressOn"
                              ? `swipe ${x} ${y} ${x} ${y} ${duration}`
                              : `tap ${x} ${y}`
                          }`,
                      )
                    : [],
                );
                if (gesture === "longPressAt") {
                  expect(tap.mock.calls[0][2]).toBe(1000);
                  expect(tap.mock.calls[0][3]).toBe(DEFAULT_GESTURE_REQUEST_TIMEOUT_MS);
                }
                if (gesture === "longPressOn") {
                  expect(tap.mock.calls[0][2]).toBe(800);
                  expect(tap.mock.calls[0][3]).toBe(DEFAULT_GESTURE_REQUEST_TIMEOUT_MS);
                }
                if (gesture === "tapAt" || gesture === "tapOn" || gesture === "doubleTapOn") {
                  for (const call of tap.mock.calls) {
                    expect(call[3]).toBeUndefined();
                  }
                }
                if (gesture === "pinch") {
                  expect(pinch.mock.calls[0].slice(0, 2)).toEqual([100, 100]);
                }
              } else if (gesture === "pinch") {
                expect(result.error).toBe(
                  "Android CtrlProxy does not expose per-display pinch dispatch; a targeted two-finger gesture requires CtrlProxy displayId support.",
                );
                expect(calls).toEqual([]);
                expect(inputs).toEqual([]);
              } else {
                expect(result.success).toBe(true);
                expect(calls).toEqual([]);
                expect(inputs.length).toBeGreaterThan(0);
                expect(
                  inputs.every((command) => command.startsWith("shell input touchscreen -d 2 ")),
                ).toBe(true);
              }
            } finally {
              for (const spy of [commands, tap, doubleTap, swipe, drag, pinch, manager]) {
                spy.mockRestore();
              }
            }
          });
        }
      }
    }
  }
});

describe("display routing capability lookup fences", () => {
  for (const gesture of ["tapAt", "tapOn", "swipe", "drag", "pinch"] as const) {
    for (const interrupt of ["transition", "cancel"] as const) {
      test(`${gesture} rechecks ${interrupt} after capability lookup`, async () => {
        displayTransitions.reset(android.deviceId);
        const observation = screen("external");
        const observe = new FakeObserveScreen();
        observe.setObserveResult(observation);
        const executor = adb();
        const timer = new FakeTimer();
        const controller = new AbortController();
        const capability = spyOn(
          AndroidCtrlProxyClient.prototype,
          "supportsCommand",
        ).mockImplementation(async () => {
          if (interrupt === "transition") {
            displayTransitions.notifyTransition(android.deviceId, "fold");
          } else {
            controller.abort(new Error("Cancelled during capability lookup"));
          }
          return true;
        });
        const tap = spyOn(
          AndroidCtrlProxyClient.prototype,
          "requestTapCoordinates",
        ).mockResolvedValue({ success: true, totalTimeMs: 0 });
        const swipe = spyOn(AndroidCtrlProxyClient.prototype, "requestSwipe").mockResolvedValue({
          success: true,
          totalTimeMs: 0,
        });
        const drag = spyOn(AndroidCtrlProxyClient.prototype, "requestDrag").mockResolvedValue({
          success: true,
          totalTimeMs: 0,
        });
        const pinch = spyOn(AndroidCtrlProxyClient.prototype, "requestPinch").mockResolvedValue({
          success: true,
          totalTimeMs: 0,
        });
        const deps = { timer, lastRenderedObservation: () => observation };
        try {
          let pending: Promise<{ success: boolean; staleDisplay?: unknown; error?: string }>;
          if (gesture === "tapAt") {
            const action = new TapAtCoordinate(android, executor, deps);
            action.observeScreen = observe;
            pending = action.execute(
              { x: 40, y: 50, display: "external" },
              undefined,
              controller.signal,
            );
          } else if (gesture === "tapOn") {
            const action = new TapOnElement(android, executor as unknown as AdbClient, deps);
            action.observeScreen = observe;
            pending = action.execute(
              { text: "Settings", display: "external" },
              undefined,
              controller.signal,
            );
          } else if (gesture === "swipe") {
            const action = new SwipeOn(android, executor as unknown as AdbClient, {
              ...deps,
              observeScreen: observe,
            });
            pending = action.execute(
              { direction: "up", display: "external" },
              undefined,
              controller.signal,
            );
          } else if (gesture === "drag") {
            const action = new DragAndDrop(android, executor as unknown as AdbClient, timer, deps);
            action.observeScreen = observe;
            pending = action.execute(
              { source: { text: "Settings" }, target: { text: "Settings" }, display: "external" },
              undefined,
              controller.signal,
            );
          } else {
            const action = new PinchOn(android, executor as unknown as AdbClient, deps);
            action.observeScreen = observe;
            pending = action.execute(
              { direction: "in", display: "external" },
              undefined,
              controller.signal,
            );
          }
          if (interrupt === "cancel") {
            if (gesture === "swipe" || gesture === "pinch" || gesture === "drag") {
              await expect(pending).rejects.toThrow("Operation cancelled");
            } else {
              const result = await pending;
              expect(result.success).toBe(false);
              expect(result.error).toContain("Operation cancelled");
            }
          } else {
            const result = await pending;
            expect(result.success).toBe(false);
            expect(result.staleDisplay).toBeDefined();
          }
          for (const spy of [tap, swipe, drag, pinch]) {
            expect(spy).not.toHaveBeenCalled();
          }
          expect(
            executor.getExecutedCommands().filter((command) => command.startsWith("shell input")),
          ).toEqual([]);
        } finally {
          for (const spy of [capability, tap, swipe, drag, pinch]) {
            spy.mockRestore();
          }
          displayTransitions.reset(android.deviceId);
        }
      });
    }
  }
});

describe("display gesture dispatch boundary race", () => {
  const kinds = ["tapOn", "tapAt", "swipe", "drag", "pinch", "defaultTapAt"] as const;
  for (const kind of kinds) {
    for (const phase of ["transition", "unchanged", "abort", "adbTransition"] as const) {
      // Targeted pinch has no ADB implementation; absence of capability remains a refusal.
      if (kind === "pinch" && phase === "adbTransition") {
        continue;
      }
      test(`${kind}: ${phase} at the final dispatch boundary`, async () => {
        displayTransitions.reset(android.deviceId);
        const transitions = new FakeDisplayTransitionReader();
        transitions.fullRevision = 0;
        transitions.generation = 1;
        transitions.panel = { key: "external", role: "external" };
        const connecting = Promise.withResolvers<boolean>();
        const reachedDispatch = Promise.withResolvers<void>();
        class DispatchAdb extends FakeAdbExecutor {
          override async execute(args: string[], options: AdbExecuteOptions = {}) {
            if (args.join(" ").startsWith("shell input")) {
              transitions.transition();
            }
            return super.execute(args, options);
          }
          override async executeCommand(...args: Parameters<FakeAdbExecutor["executeCommand"]>) {
            // Model path resolution on the old positional API as well as execute().
            if (phase === "adbTransition" && args[0].startsWith("shell input")) {
              transitions.transition();
            }
            return super.executeCommand(...args);
          }
        }
        const executor = phase === "adbTransition" ? new DispatchAdb() : adb();
        executor.setCommandResponse("cmd display get-displays", {
          stdout:
            'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
          stderr: "",
        });
        const observation = screen("external");
        const observe = new FakeObserveScreen();
        observe.setObserveResult(observation);
        const timer = autoTimer();
        const wireTimer = new FakeTimer();
        const requestManager = new RequestManager(wireTimer);
        const sent: string[] = [];
        const socket = {
          readyState: 1,
          send: (data: string) => {
            sent.push(data);
            const message = JSON.parse(data) as { requestId: string };
            requestManager.resolve(message.requestId, { success: true, totalTimeMs: 0 });
          },
        } as WebSocket;
        const deps = {
          timer,
          lastRenderedObservation: () => observation,
          displayTransitions: transitions,
        };
        const action =
          kind === "tapOn"
            ? new TapOnElement(android, executor, deps)
            : kind === "tapAt" || kind === "defaultTapAt"
              ? new TapAtCoordinate(android, executor, deps)
              : kind === "swipe"
                ? new SwipeOn(android, executor as unknown as AdbClient, {
                    ...deps,
                    observeScreen: observe,
                  })
                : kind === "drag"
                  ? new DragAndDrop(android, executor as unknown as AdbClient, timer, deps)
                  : new PinchOn(android, executor as unknown as AdbClient, deps);
        action.observeScreen = observe;
        const client = AndroidCtrlProxyClient.getExistingInstance(android.deviceId)!;
        const previousGestures = client["_gestures"];
        client["_gestures"] = new CtrlProxyGestures({
          getWebSocket: () => socket,
          ensureConnected: () => {
            reachedDispatch.resolve();
            return phase === "adbTransition" ? Promise.resolve(false) : connecting.promise;
          },
          isCommandSupported: () => true,
          requestManager,
          timer: wireTimer,
          cancelScreenshotBackoff: () => {},
        });
        const capability = spyOn(client, "supportsCommand").mockResolvedValue(
          phase !== "adbTransition",
        );
        const manager = spyOn(AndroidCtrlProxyManager.prototype, "isAvailable").mockResolvedValue(
          true,
        );
        const controller = new AbortController();
        // Keep this test about action dispatch, not post-observation settling.
        Object.assign(action, { observedInteraction: async (run: () => Promise<object>) => run() });
        try {
          const display = kind === "defaultTapAt" ? undefined : "external";
          const pending = (
            action instanceof TapOnElement
              ? action.execute({ text: "Settings", display }, undefined, controller.signal)
              : action instanceof TapAtCoordinate
                ? action.execute({ x: 40, y: 50, display }, undefined, controller.signal)
                : action instanceof SwipeOn
                  ? action.execute({ direction: "up", display }, undefined, controller.signal)
                  : action instanceof DragAndDrop
                    ? action.execute(
                        { source: { text: "Settings" }, target: { text: "Settings" }, display },
                        undefined,
                        controller.signal,
                      )
                    : action.execute(
                        { direction: "in", display, autoTarget: false },
                        undefined,
                        controller.signal,
                      )
          ).then(
            (result) => ({ result, error: undefined }),
            (error: unknown) => ({ result: undefined, error }),
          );
          if (phase !== "adbTransition") {
            await reachedDispatch.promise;
            expect(sent).toHaveLength(0);
            if (phase === "transition") {
              transitions.transition();
            }
            if (phase === "abort") {
              controller.abort(new Error("Operation cancelled"));
            }
            connecting.resolve(true);
          }
          const outcome = await pending;
          expect(requestManager.getPendingCount()).toBe(0);
          expect(wireTimer.getPendingTimeoutCount()).toBe(0);
          const inputs = executor
            .getExecutedCommands()
            .filter((command) => command.startsWith("shell input"));
          if (phase === "transition" || phase === "adbTransition") {
            expect(sent).toHaveLength(0);
            expect(inputs).toEqual([]);
            expect(outcome.result?.success).toBe(false);
            expect(outcome.result?.staleDisplay).toMatchObject({
              observedGeneration: 1,
              currentGeneration: 2,
              retry: "observe",
            });
          } else if (phase === "abort") {
            expect(sent).toHaveLength(0);
            expect(inputs).toEqual([]);
            if (kind === "swipe" || kind === "pinch" || kind === "drag") {
              expect(outcome.error).toBeInstanceOf(Error);
              expect((outcome.error as Error).message).toContain("Operation cancelled");
            } else {
              expect(outcome.result?.success).toBe(false);
              expect(outcome.result?.error).toContain("Operation cancelled");
            }
          } else {
            expect(sent).toHaveLength(1);
            expect(inputs).toEqual([]);
            expect(outcome.result?.success).toBe(true);
          }
        } finally {
          client["_gestures"] = previousGestures;
          capability.mockRestore();
          manager.mockRestore();
          displayTransitions.reset(android.deviceId);
        }
      });
    }
  }
});

// screencap -d takes the SurfaceFlinger physical id, not the logical id 2 the tap targets.
const EXTERNAL_PHYSICAL_DISPLAY_ID = "4619827259835644673";

describe("post-action screenshot resolved display", () => {
  test.each(["explicit", "pinned", "legacy", "unmappable", "pinnedCtrlProxy"] as const)(
    "%s display reaches the automatic capture command",
    async (route) => {
      const oldPolicy = process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV];
      const oldMode = process.env[OBSERVE_SETTLED_SCREENSHOT_ENV];
      const oldAudit = serverConfig.getAccessibilityAuditConfig();
      process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV] = "0";
      process.env[OBSERVE_SETTLED_SCREENSHOT_ENV] = "0";
      serverConfig.setAccessibilityAuditConfig(null);
      displayTransitions.reset(android.deviceId);
      const executor = adb();
      executor.setCommandResponse("dumpsys SurfaceFlinger", { stdout: "", stderr: "" });
      executor.setCommandResponse("screencap", {
        stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
        stderr: "",
      });
      const timer = autoTimer();
      const screenshot = new TakeScreenshot(
        android,
        new FakeAdbClientFactory(executor),
        timer,
        new FakeIdGenerator(["capture", "command"]),
        new FakeScreenshotFileWriter(),
        new FakeFileSystem(),
        () => "/fake/screenshots",
        new FakeAndroidPhysicalDisplayIdResolver(new Map([[2, EXTERNAL_PHYSICAL_DISPLAY_ID]])),
        false,
        { pathProtection: new FakeScreenshotPathProtection(timer) },
      );
      const ids: Array<number | undefined> = [];
      // Forward production display selection to the real screenshot transport.
      class CaptureRecorder extends FakeScreenshotRecorder {
        override async captureFresh(
          _id?: string,
          _perf?: PerformanceTracker,
          signal?: AbortSignal,
          displayId?: number,
        ): Promise<void> {
          ids.push(displayId);
          expect(
            (
              await screenshot.execute(
                { format: route === "pinnedCtrlProxy" ? "jpeg" : "png", displayId },
                signal,
              )
            ).success,
          ).toBe(true);
        }
      }
      const realObserve = new RealObserveScreen(
        android,
        new FakeAdbClientFactory(executor),
        { screenshotRecorder: new CaptureRecorder() },
        timer,
      );
      const fakeObserve = new FakeObserveScreen();
      fakeObserve.setObserveResult(
        screen(route === "unmappable" ? "missing" : route === "legacy" ? "internal" : "external"),
      );
      const execute = spyOn(realObserve, "execute").mockImplementation((options) =>
        fakeObserve.execute(options),
      );
      const capability = spyOn(
        AndroidCtrlProxyClient.prototype,
        "supportsCommand",
      ).mockResolvedValue(false);
      // The legacy (no display) route dispatches through CtrlProxy; the real client would try a
      // localhost WebSocket connect (~270 ms), so answer it in-process.
      const tap = spyOn(
        AndroidCtrlProxyClient.prototype,
        "requestTapCoordinates",
      ).mockResolvedValue({ success: true, totalTimeMs: 0 });
      const action = new TapAtCoordinate(android, executor, {
        timer,
        lastRenderedObservation: () => screen("external"),
      });
      action.observeScreen = realObserve;
      const wireMessages: Array<{ type: string; requestId: string; displayId?: number }> = [];
      let wireClient: AndroidCtrlProxyClient | undefined;
      let instanceSpy: ReturnType<typeof spyOn> | undefined;
      if (route === "pinnedCtrlProxy") {
        const wireTimer = new FakeTimer();
        const socket = new FakeWebSocket("ws://fake", "none", 0, wireTimer);
        socket.readyState = WebSocketState.OPEN;
        const client = AndroidCtrlProxyClient.createForTesting(
          android,
          executor,
          () => socket as WebSocket,
          wireTimer,
        );
        client["ws"] = socket as WebSocket;
        client["connectWebSocket"] = async () => true;
        client["screenshotBackoffScheduler"] = new FakeScreenshotBackoffScheduler();
        socket.send = (data: string) => {
          const message = JSON.parse(data) as {
            type: string;
            requestId: string;
            displayId?: number;
          };
          wireMessages.push(message);
          client["requestManager"].resolve(message.requestId, {
            success: true,
            data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
            format: "jpeg",
          });
        };
        wireClient = client;
        instanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
      }
      try {
        const response = await runSessionDisplayPin({
          name: "tapAt",
          acceptsDisplay: true,
          device: android,
          args: route === "explicit" ? { display: "external" } : {},
          sessionUuid: "capture-session",
          store: {
            getDeviceForSession: () => android.deviceId,
            getDisplayPin: () =>
              route === "pinned" || route === "pinnedCtrlProxy" ? "external" : undefined,
          },
          invoke: (args) =>
            action.execute({
              x: 50,
              y: 60,
              display: typeof args.display === "string" ? args.display : undefined,
            }),
        });
        expect(response).toMatchObject({ success: true });
        const commands = executor
          .getExecutedCommands()
          .filter((command) => command.includes("screencap"));
        const targeted = route === "explicit" || route === "pinned" || route === "pinnedCtrlProxy";
        console.log(
          `${route}: screenshot displayId=${String(ids[0])}; capture=${commands[0] ?? JSON.stringify(wireMessages[0])}`,
        );
        if (targeted) {
          expect(executor.getExecutedCommands()).toContain(
            "shell input touchscreen -d 2 tap 50 60",
          );
        }
        expect(ids).toEqual([targeted ? 2 : undefined]);
        if (route === "pinnedCtrlProxy") {
          expect(commands).toEqual([]);
          expect(wireMessages).toEqual([
            { type: "request_screenshot", requestId: expect.any(String), displayId: 2 },
          ]);
          expect(wireClient?.["requestManager"].getPendingCount()).toBe(0);
        } else {
          expect(commands).toEqual([
            `shell "screencap ${targeted ? `-d ${EXTERNAL_PHYSICAL_DISPLAY_ID} ` : ""}-p /data/local/tmp/am-shot-command-5d347fd948b6.png && base64 /data/local/tmp/am-shot-command-5d347fd948b6.png && rm /data/local/tmp/am-shot-command-5d347fd948b6.png"`,
          ]);
        }
      } finally {
        instanceSpy?.mockRestore();
        await wireClient?.close();
        serverConfig.setAccessibilityAuditConfig(oldAudit);
        execute.mockRestore();
        capability.mockRestore();
        tap.mockRestore();
        if (oldPolicy === undefined) {
          delete process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV];
        } else {
          process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV] = oldPolicy;
        }
        if (oldMode === undefined) {
          delete process.env[OBSERVE_SETTLED_SCREENSHOT_ENV];
        } else {
          process.env[OBSERVE_SETTLED_SCREENSHOT_ENV] = oldMode;
        }
        displayTransitions.reset(android.deviceId);
      }
    },
  );
});

describe("selected-display double tap delivery", () => {
  for (const kind of ["tapOn", "tapAny"] as const) {
    for (const failure of [
      "abort in gap",
      "display change in gap",
      "second tap post-send failure",
      "first tap pre-dispatch failure",
      "abort before dispatch",
      "pre-dispatch fallback",
    ] as const) {
      test(`${kind} double tap delivery: ${failure}`, async () => {
        const executor = adb();
        const timer = autoTimer();
        const transitions = new FakeDisplayTransitionReader();
        transitions.panel = { key: "external", role: "external" };
        const observation = screen("external");
        observation.displayRevision = transitions.fullRevision;
        observation.display.generation = transitions.generation;
        const observe = new FakeObserveScreen();
        observe.setObserveResult(observation);
        const controller = new AbortController();
        let tapsDelivered = 0;
        const capability = spyOn(
          AndroidCtrlProxyClient.prototype,
          "supportsCommand",
        ).mockResolvedValue(true);
        const tap = spyOn(
          AndroidCtrlProxyClient.prototype,
          "requestTapCoordinates",
        ).mockImplementation(async (...args) => {
          args[9]?.();
          expect(args[8]).toBe(2);
          if (failure === "first tap pre-dispatch failure") {
            return { success: false, error: "Stale frame context" };
          }
          if (failure === "pre-dispatch fallback" && tap.mock.calls.length === 1) {
            return { success: false, error: "Not connected" };
          }
          args[6]?.();
          if (failure === "second tap post-send failure" && tap.mock.calls.length === 2) {
            return { success: false, error: "Tap timed out after send" };
          }
          tapsDelivered++;
          return { success: true };
        });
        // The real method opens a localhost WebSocket (#10470), so keep the sequential two-tap
        // path under test deterministic and off the network.
        const doubleTap = spyOn(
          AndroidCtrlProxyClient.prototype,
          "requestDoubleTapCoordinates",
        ).mockResolvedValue({
          success: false,
          totalTimeMs: 0,
          error: "tap_double_v1 is not confirmed by the connected device service",
        });
        const sleep = timer.sleep.bind(timer);
        const gap = spyOn(timer, "sleep").mockImplementation((ms) => {
          const pending = sleep(ms);
          if (ms === DOUBLE_TAP_GAP_MS && tapsDelivered === 1) {
            if (failure === "abort in gap") {
              controller.abort();
            } else if (failure === "display change in gap") {
              transitions.transition();
            }
          }
          return pending;
        });
        try {
          const deps = {
            timer,
            displayTransitions: transitions,
            hierarchyCapture: new FakeHierarchyCapture(() => observation.viewHierarchy!),
            lastRenderedObservation: () => observation,
            accessibilityDetector: new FakeAccessibilityDetector(),
          };
          const action =
            kind === "tapOn"
              ? new TapOnElement(android, executor, deps)
              : new TapAnyElement(android, executor as unknown as AdbClient, deps);
          action.observeScreen = observe;
          if (failure === "abort before dispatch") {
            controller.abort(new Error(OPERATION_CANCELLED_MESSAGE));
          }
          const pending =
            action instanceof TapOnElement
              ? action.execute(
                  { text: "Settings", action: "doubleTap", display: "external" },
                  undefined,
                  controller.signal,
                )
              : action.execute(
                  { action: "doubleTap", display: "external" },
                  undefined,
                  controller.signal,
                );
          const partial =
            failure === "abort in gap" ||
            failure === "display change in gap" ||
            failure === "second tap post-send failure";
          if (failure === "abort before dispatch" && kind === "tapAny") {
            await expect(pending).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
            await expect(pending).rejects.not.toThrow(/indeterminate|partially applied/i);
          } else {
            const result = await pending;
            expect(result.success).toBe(failure === "pre-dispatch fallback");
            if (partial) {
              expect(result.error).toContain("Tap outcome is indeterminate");
              expect(result.error).toContain(
                "Double tap partially applied: one tap was delivered; the second tap was not confirmed",
              );
              expect(result.error).toContain("Do not retry automatically");
              expect(result.error).not.toContain("2 taps were delivered");
              expect(result.error).toContain(
                failure === "abort in gap"
                  ? OPERATION_CANCELLED_MESSAGE
                  : failure === "display change in gap"
                    ? "Display changed"
                    : "Tap timed out after send",
              );
            } else if (failure !== "pre-dispatch fallback") {
              expect(result.error).toContain(
                failure === "abort before dispatch"
                  ? OPERATION_CANCELLED_MESSAGE
                  : "Stale frame context",
              );
              expect(result.error).not.toMatch(/indeterminate|partially applied/i);
            }
          }
          expect(tapsDelivered).toBe(partial || failure === "pre-dispatch fallback" ? 1 : 0);
          expect(tap.mock.calls).toHaveLength(
            failure === "abort before dispatch"
              ? 0
              : failure === "second tap post-send failure" || failure === "pre-dispatch fallback"
                ? 2
                : 1,
          );
          expect(
            executor.getExecutedCommands().filter((command) => command.includes("touchscreen")),
          ).toEqual(
            failure === "pre-dispatch fallback" ? ["shell input touchscreen -d 2 tap 50 60"] : [],
          );
          if (partial) {
            expect(timer.getSleepHistory()).toContain(DOUBLE_TAP_GAP_MS);
          }
        } finally {
          gap.mockRestore();
          doubleTap.mockRestore();
          tap.mockRestore();
          capability.mockRestore();
        }
      });
    }
  }
});
