import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { SendKeys } from "../../../src/features/action/SendKeys";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
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
import { FakeTimer } from "../../fakes/FakeTimer";

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

function adb(): FakeAdbExecutor {
  const result = new FakeAdbExecutor();
  result.setCommandResponse("cmd display get-displays", {
    stdout:
      'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
    stderr: "",
  });
  return result;
}

describe("explicit action display", () => {
  beforeEach(() => {
    displayTransitions.reset(android.deviceId);
    displayTransitions.reset(ios.deviceId);
  });

  afterEach(() => DaemonState.getInstance().reset());

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
      timer,
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
          setDisplayRevision: (uuid, revision, key) =>
            manager.setLastRenderedDisplayRevision(uuid, revision, key),
        },
      });
      expect(sessionRenderedObservation(android.deviceId)?.display.key).toBe("external");
      expect(manager.getLastRenderedObservation(sessionId)).toBeUndefined();
      const after = await action.execute({ x: 40, y: 50, display: "external" });
      expect(after.success).toBe(true);
      expect(executor.getExecutedCommands()).toContain("shell input -d 2 touchscreen tap 40 50");
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
      observeScreen: observe,
      lastRenderedObservation: sessionRenderedObservation,
    });
    const signal = new AbortController().signal;
    expect(
      (await swipe.execute({ direction: "up", display: "external" }, undefined, signal)).success,
    ).toBe(true);
    expect(fakeAdb.getCommandCalls().at(-1)?.signal).toBe(signal);
    expect(observe.getExecuteOptions().at(-1)?.signal).toBe(signal);

    const drag = new DragAndDrop(android, fakeAdb as unknown as AdbClient, timer, {
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
      timer: new FakeTimer(),
      androidClient: client,
      iosClient: client,
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;
    const result = await action.execute({ x: 40, y: 50, display: "external" });
    expect(result.success).toBe(true);
    expect(executor.getExecutedCommands()).toContain("shell input -d 2 touchscreen tap 40 50");
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
      timer: new FakeTimer(),
      androidClient: client,
      iosClient: client,
    });
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
        timer: new FakeTimer(),
        tapStrategy: {
          isAccessibilityServiceEnabled: async () => false,
          shouldRunPreTapStability: () => false,
        } as never,
      });
      Object.assign(action, {
        observedInteraction: async (run: (observation: ObserveResult) => Promise<object>) => ({
          ...(await run(observation)),
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
    const timer = new FakeTimer();
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
      timer: new FakeTimer(),
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
      timer: new FakeTimer(),
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;
    const result = await action.execute({ text: "Settings", action: "tap", display: "external" });
    expect(result.success).toBe(true);
    expect(executor.getExecutedCommands()).toContain("shell input -d 2 touchscreen tap 50 60");
  });

  test("tapOn reports a missing target on the selected display", async () => {
    const executor = adb();
    const observation = screen("external", "Settings");
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const action = new TapOnElement(android, executor, {
      timer: new FakeTimer(),
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;
    const result = await action.execute({ text: "Other app", action: "tap", display: "external" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found on selected display");
  });

  test("tapOn rejects display options it cannot honor before dispatch", async () => {
    const unsupported: Array<Partial<TapOnElementOptions>> = [
      { ensureChecked: true },
      { sibling: true },
      { subtext: { text: "Link" } },
      { searchUntil: { duration: 100 } },
      { retryIfNoChange: true },
      { ensureTap: true },
      { textAny: ["One", "Two"] },
      { accessibilityLink: "Link" },
    ];
    const executor = adb();
    const observe = new FakeObserveScreen();
    const action = new TapOnElement(android, executor, { timer: new FakeTimer() });
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
    const unsupported: Array<Partial<SwipeOnOptions>> = [
      { lookFor: { text: "Found" } },
      { boomerang: true },
      { apexPause: 10 },
      { returnSpeed: 2 },
      { speed: "fast" },
      { autoTarget: true },
      { includeSystemInsets: true },
    ];
    const observe = new FakeObserveScreen();
    const fakeAdb = new FakeAdbClient();
    const action = new SwipeOn(android, fakeAdb as unknown as AdbClient, {
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

  test("dragAndDrop rejects press and hold durations with display", async () => {
    const fakeAdb = new FakeAdbClient();
    const action = new DragAndDrop(android, fakeAdb as unknown as AdbClient, new FakeTimer());
    for (const extra of [{ pressDurationMs: 700 }, { holdDurationMs: 200 }]) {
      const result = await action.execute({
        source: { text: "Source" },
        target: { text: "Target" },
        display: "external",
        ...extra,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported with `display` yet");
    }
    expect(fakeAdb.getAllCommands()).toEqual([]);
  });

  test("coordinates observed on display 0 cannot target external", async () => {
    const executor = adb();
    const observe = new FakeObserveScreen();
    observe.setObserveResult(screen("external"));
    const client = { requestTapCoordinates: async () => ({ success: true }) };
    const action = new TapAtCoordinate(android, executor, {
      timer: new FakeTimer(),
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
      timer: new FakeTimer(),
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
      timer: new FakeTimer(),
      androidClient: client,
      iosClient: client,
      lastRenderedObservation: () => observation,
    });
    action.observeScreen = observe;
    const result = await action.execute({ x: 40, y: 50, display: "external" });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Re-observe display "external"');
    expect(executor.getExecutedCommands()).toEqual([]);
  });

  test("sendKeys discrete key routes to display 2 and observes it afterward", async () => {
    const executor = adb();
    const observation = screen("external");
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const action = new SendKeys(android, new FakeAdbClientFactory(executor), {
      timer: new FakeTimer(),
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

  test("sendKeys text focuses a field on the selected display", async () => {
    const executor = adb();
    const observation = screen("external");
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const focused: string[] = [];
    const typed: string[] = [];
    const action = new SendKeys(android, new FakeAdbClientFactory(executor), {
      timer: new FakeTimer(),
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
