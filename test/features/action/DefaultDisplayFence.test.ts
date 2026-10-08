import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { hierarchyFingerprint } from "../../../src/utils/hierarchyFingerprint";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import type { Element } from "../../../src/models";
import { TalkBackTapStrategy } from "../../../src/features/talkback/TalkBackTapStrategy";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import type { BaseActionResult, BootedDevice } from "../../../src/models";
import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../fakes/FakeWindow";
import { observation } from "../../helpers/tapAtCoordinate";

const modes = ["transition", "unchanged", "single-absent", "single-panel"] as const;
type Mode = (typeof modes)[number];
const restores: Array<() => void> = [];
afterEach(() => {
  restores
    .splice(0)
    .reverse()
    .forEach((restore) => restore());
});
function watch<T extends object, K extends keyof T>(target: T, key: K) {
  const spy = spyOn(target, key);
  restores.push(() => spy.mockRestore());
  return spy;
}
function harness(platform: "android" | "ios", mode: Mode) {
  const device: BootedDevice = {
    deviceId: `default-fence-${platform}`,
    name: "fake",
    platform,
    ...(mode === "single-absent"
      ? {}
      : {
          displays: {
            panels: [
              { key: "inner", role: "inner" as const, sizePx: { width: 100, height: 200 } },
              ...(mode === "single-panel"
                ? []
                : [{ key: "cover", role: "cover" as const, sizePx: { width: 100, height: 200 } }]),
            ],
            postures: [],
          },
        }),
  };
  const transitions = new FakeDisplayTransitionReader();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = Object.assign(new FakeAdbExecutor(), {
    spawn: async () => {
      throw new Error("Unexpected ADB process spawn in fence test");
    },
  });
  adb.setDeviceTimestampMs(0);
  const screen: import("../../../src/models").ObserveResult = {
    ...observation(100, 200, "frame", 0, {
      node: [
        { text: "Source", clickable: true, bounds: { left: 10, top: 20, right: 30, bottom: 40 } },
        {
          text: "Target",
          clickable: true,
          scrollable: true,
          bounds: { left: 40, top: 60, right: 80, bottom: 100 },
        },
      ],
    }),
    displayRevision: 41,
    display: { key: "inner", role: "inner", posture: "opened", generation: 7 },
  };
  const observe = Object.assign(new FakeObserveScreen(), { captureCacheGeneration: () => 0 });
  observe.setObserveResult(screen);
  // Start these dispatch-fence tests with this call's observer read.
  watch(observe, "getMostRecentCachedObserveResult").mockResolvedValue({
    ...screen,
    freshness: { isFresh: false },
  });
  const android = new FakeCtrlProxy();
  const ios = new FakeIOSCtrlProxy(timer);
  watch(AndroidCtrlProxyClient.prototype, "requestTapCoordinates").mockImplementation(
    android.requestTapCoordinates.bind(android),
  );
  // The real method opens a localhost WebSocket (a host emulator's adb forward can answer it), so
  // keep the sequential two-tap path under test deterministic and off the network.
  watch(AndroidCtrlProxyClient.prototype, "requestDoubleTapCoordinates").mockResolvedValue({
    success: false,
    totalTimeMs: 0,
    error: "tap_double_v1 is not confirmed by the connected device service",
  });
  watch(AndroidCtrlProxyClient.prototype, "requestSwipe").mockImplementation(
    android.requestSwipe.bind(android),
  );
  watch(AndroidCtrlProxyClient.prototype, "requestDrag").mockImplementation(
    android.requestDrag.bind(android),
  );
  watch(AndroidCtrlProxyClient.prototype, "requestPinch").mockImplementation(
    android.requestPinch.bind(android),
  );
  watch(IOSCtrlProxyClient.prototype, "requestTapCoordinates").mockImplementation(
    ios.requestTapCoordinates.bind(ios),
  );
  watch(IOSCtrlProxyClient.prototype, "requestMultiFingerSwipe").mockImplementation(
    ios.requestMultiFingerSwipe.bind(ios),
  );
  watch(IOSCtrlProxyClient.prototype, "requestSwipe").mockImplementation(
    ios.requestSwipe.bind(ios),
  );
  watch(IOSCtrlProxyClient.prototype, "requestDrag").mockImplementation(ios.requestDrag.bind(ios));
  watch(IOSCtrlProxyClient.prototype, "requestPinch").mockImplementation(
    ios.requestPinch.bind(ios),
  );
  watch(AndroidCtrlProxyManager.prototype, "isAvailable").mockResolvedValue(true);
  const detector = new FakeAccessibilityDetector();
  const voiceOver = new FakeIosVoiceOverDetector();
  const bump = async () => {
    await Promise.resolve();
    if (mode === "transition") {
      transitions.transition(1);
    }
  };
  const deps = {
    timer,
    displayTransitions: transitions,
    renderedDisplayRevision: () => undefined,
    renderedDisplayGeneration: () => 7,
    accessibilityDetector: detector,
    iosVoiceOverDetector: voiceOver,
    visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
    executeGesture: new ExecuteGesture(device, adb, timer),
  };
  const attach = <T extends BaseVisualChange>(action: T): T => {
    Object.assign(action, {
      observeScreen: observe,
      awaitIdle: new FakeAwaitIdle(),
      window: new FakeWindow(),
      adb,
      adbFactory: { create: () => adb },
    });
    return action;
  };
  const taps = () => (platform === "ios" ? ios.getTapHistory() : android.getTapHistory());
  const inputs = () => adb.getExecutedCommands().filter((cmd) => cmd.includes("input "));
  return {
    device,
    transitions,
    timer,
    adb,
    screen,
    observe,
    android,
    ios,
    detector,
    voiceOver,
    bump,
    deps,
    attach,
    taps,
    inputs,
  };
}
function assertResult(result: BaseActionResult) {
  expect(result.success).toBe(false);
  const details = {
    observedGeneration: 7,
    currentGeneration: 8,
    currentDisplayKey: "cover",
    retry: "observe" as const,
  };
  expect(result.staleDisplay).toEqual(details);
  expect(result.error).toBe(new StaleDisplayError(details).message);
}

// The transition is injected at a real deferred preparation boundary, after block entry.
describe("default-display dispatch fences", () => {
  for (const platform of ["android", "ios"] as const) {
    for (const tool of ["tapOn", "tapAny"] as const) {
      for (const site of ["preparation", "double-second", "double-unchanged"] as const) {
        test.each(modes)(`${tool} ${platform} ${site}: %s`, async (mode: Mode) => {
          const h = harness(platform, mode);
          const actionName = site === "preparation" ? "tap" : "doubleTap";
          let run: () => Promise<BaseActionResult>;
          if (tool === "tapOn") {
            const strategy = new FakeTapStrategy();
            const action = h.attach(
              new TapOnElement(h.device, h.adb, {
                ...h.deps,
                tapStrategy: strategy,
                waitForCondition: {
                  execute: async () => ({
                    matched: false,
                    candidates: [],
                    observation: h.screen,
                    polls: 1,
                    waitMs: 0,
                    timedOut: true,
                  }),
                },
                selectionStateTracker: {
                  prepare: async () => {
                    if (site === "preparation") {
                      await h.bump();
                    }
                    return null;
                  },
                  finalize: async () => [],
                },
              }),
            );
            run = () => action.execute({ text: "Target", action: actionName });
          } else {
            if (site === "preparation") {
              watch(h.detector, "detectMethod").mockImplementation(async () => {
                await h.bump();
                return "unknown";
              });
              watch(h.voiceOver, "isVoiceOverActiveOrUnknown").mockImplementation(async () => {
                await h.bump();
                return false;
              });
            }
            const action = h.attach(new TapAnyElement(h.device, null, h.deps));
            action.setRefreshViewHierarchyForTesting(async () => null);
            run = () => action.execute({ action: actionName });
          }
          if (site === "double-second") {
            const sleep = h.timer.sleep.bind(h.timer);
            watch(h.timer, "sleep").mockImplementation(async (ms: number) => {
              if (h.taps().length === 1) {
                await h.bump();
              }
              return sleep(ms);
            });
          }
          const result = await run();
          const stale = mode === "transition" && site !== "double-unchanged";
          if (stale) {
            assertResult(result);
          } else {
            expect(result.success).toBe(true);
            expect(result.staleDisplay).toBeUndefined();
          }
          const count = stale
            ? site === "double-second"
              ? 1
              : 0
            : actionName === "doubleTap"
              ? 2
              : 1;
          expect(h.taps()).toHaveLength(count);
          expect(h.taps().map(({ x, y }) => ({ x, y }))).toEqual(
            Array.from({ length: count }, () =>
              tool === "tapAny" ? { x: 20, y: 30 } : { x: 60, y: 80 },
            ),
          );
          expect(h.inputs()).toEqual([]);
        });
      }
    }
    for (const tool of ["pinch", "drag"] as const) {
      test.each(modes)(`${tool} ${platform} target capture: %s`, async (mode: Mode) => {
        const h = harness(platform, mode);
        const capture = new FakeHierarchyCapture(async () => {
          await h.bump();
          return h.screen.viewHierarchy!;
        }, platform);
        const result =
          tool === "pinch"
            ? await h
                .attach(new PinchOn(h.device, null, { ...h.deps, capture }))
                .execute({ direction: "in", autoTarget: false })
            : await h
                .attach(
                  new DragAndDrop(h.device, null, h.timer, {
                    ...h.deps,
                    hierarchyCapture: capture,
                  }),
                )
                .execute({ source: { text: "Source" }, target: { text: "Target" } });
        if (mode === "transition") {
          assertResult(result);
        } else {
          expect(result).toMatchObject({ success: true });
        }
        const client = platform === "ios" ? h.ios : h.android;
        const calls = tool === "pinch" ? client.getPinchHistory() : client.getDragHistory();
        expect(calls).toHaveLength(mode === "transition" ? 0 : 1);
        if (mode !== "transition") {
          if (tool === "pinch") {
            expect(client.getPinchHistory()[0]).toMatchObject({ centerX: 50, centerY: 100 });
          } else {
            expect(client.getDragHistory()[0]).toMatchObject({ x1: 20, y1: 30, x2: 60, y2: 80 });
          }
        }
        expect(h.inputs()).toEqual([]);
      });
    }
    for (const site of [
      "screen",
      "element",
      "boomerang-return",
      "a11y-fallback",
      "a11y-exception",
    ] as const) {
      test.each(modes)(`swipe ${platform} ${site}: %s`, async (mode: Mode) => {
        const h = harness(platform, mode);
        if (site === "screen" || site === "element") {
          watch(h.detector, "detectMethod").mockImplementation(async () => {
            await h.bump();
            return "unknown";
          });
          watch(h.voiceOver, "resolveState").mockImplementation(async () => {
            await h.bump();
            return false;
          });
        }
        if (site === "boomerang-return") {
          const sleep = h.timer.sleep.bind(h.timer);
          watch(h.timer, "sleep").mockImplementation(async (ms: number) => {
            if (ms === 123) {
              await h.bump();
            }
            return sleep(ms);
          });
        }
        if ((site === "a11y-fallback" || site === "a11y-exception") && platform === "android") {
          watch(AndroidCtrlProxyClient.prototype, "requestSwipe").mockImplementation(async () => {
            await h.bump();
            if (site === "a11y-exception") {
              throw new Error("not sent");
            }
            return { success: false, error: "not sent" };
          });
        }
        const action = h.attach(
          new SwipeOn(h.device, null, { ...h.deps, observeScreen: h.observe }),
        );
        const result = await action.execute({
          direction: "up",
          autoTarget: false,
          ...(site === "element" ? { container: { text: "Target" } } : {}),
          ...(site === "boomerang-return" ? { boomerang: true, apexPause: 123 } : {}),
          ...(site === "a11y-fallback" || site === "a11y-exception" ? { scrollMode: "a11y" } : {}),
        });
        const stale =
          mode === "transition" &&
          !((site === "a11y-fallback" || site === "a11y-exception") && platform === "ios");
        if (stale) {
          assertResult(result);
        } else {
          expect(result.success).toBe(true);
        }
        const count = stale
          ? site === "boomerang-return"
            ? 1
            : 0
          : site === "boomerang-return"
            ? 2
            : 1;
        if (platform === "android") {
          expect(h.inputs()).toHaveLength(count);
        } else {
          expect(h.ios.getSwipeHistory()).toHaveLength(count);
        }
        if (count > 0 && site !== "element") {
          if (platform === "android") {
            expect(h.inputs()[0]).toContain("50 180 50 20");
          } else {
            expect(h.ios.getSwipeHistory()[0]).toMatchObject({ x1: 50, y1: 180, x2: 50, y2: 20 });
          }
        }
      });
    }
  }
  test.each(modes)("tapOn retry after post-tap probe: %s", async (mode: Mode) => {
    const h = harness("android", mode);
    const strategy = new FakeTapStrategy();
    strategy.retryTapIfNoChange = true;
    const action = h.attach(
      new TapOnElement(h.device, h.adb, {
        ...h.deps,
        tapStrategy: strategy,
        waitForCondition: {
          execute: async () => ({
            matched: false,
            candidates: [],
            observation: h.screen,
            polls: 1,
            waitMs: 0,
            timedOut: true,
          }),
        },
        selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
      }),
    );
    watch(action, "refreshViewHierarchy").mockImplementation(async () => {
      await h.bump();
      return h.screen.viewHierarchy!;
    });
    const result = await action.execute({ action: "tap", text: "Target", retryIfNoChange: true });
    if (mode === "transition") {
      assertResult(result);
    } else {
      expect(result).toMatchObject({ success: true });
    }
    expect(h.taps()).toHaveLength(mode === "transition" ? 1 : 2);
    expect(h.taps().map(({ x, y }) => ({ x, y }))).toEqual(
      Array.from({ length: mode === "transition" ? 1 : 2 }, () => ({ x: 60, y: 80 })),
    );
    expect(h.inputs()).toEqual([]);
  });
});

// Strategy internals await before activation, so an entry-only fence is insufficient.
describe("TalkBack waits retain the action fence", () => {
  for (const tool of ["tapOn", "tapAny"] as const) {
    for (const site of [
      "direct-fallback",
      "precise-activation",
      "double-dispatch",
      "longPress-fallback",
    ] as const) {
      test.each(modes)(`${tool} ${site}: %s`, async (mode: Mode) => {
        const h = harness("android", mode);
        const driver = new FakeTalkBackNavigationDriver();
        const factory = { createDriver: () => driver };
        const strategy = new TalkBackTapStrategy({ timer: h.timer, driverFactory: factory });
        h.detector.setTalkBackEnabled(true);
        if (site === "direct-fallback") {
          watch(strategy, "executeDirectActivation").mockImplementation(async () => {
            await h.bump();
            return { success: false, method: "accessibility-action" };
          });
        }
        if (site === "longPress-fallback") {
          Object.assign(driver, {
            getAccessibilityHierarchy: async () => ({
              hierarchy: {
                node: {
                  $: {
                    "resource-id": "target-id",
                    text: "Target",
                    bounds: { left: 40, top: 60, right: 80, bottom: 100 },
                  },
                },
              },
            }),
          });
          watch(driver, "requestAction").mockImplementation(async () => {
            await h.bump();
            return { success: false, action: "long_click" };
          });
        }
        if (site === "precise-activation") {
          const sleep = h.timer.sleep.bind(h.timer);
          watch(h.timer, "sleep").mockImplementation(async (ms: number) => {
            if (ms === 500 && driver.tapHistory.length === 1) {
              await h.bump();
            }
            return sleep(ms);
          });
        }
        if (site === "double-dispatch") {
          const fallback = strategy.executeCoordinateFallback.bind(strategy);
          watch(strategy, "executeCoordinateFallback").mockImplementation(async (...args) => {
            await h.bump();
            return fallback(...args);
          });
        }
        const actionName =
          site === "double-dispatch"
            ? "doubleTap"
            : site === "longPress-fallback"
              ? "longPress"
              : "tap";
        const tapStrategy = new FakeTapStrategy();
        tapStrategy.setAccessibilityServiceEnabled(true);
        const targetElement: Element = {
          text: "Target",
          "resource-id": site === "longPress-fallback" ? "target-id" : undefined,
          clickable: true,
          "long-clickable": true,
          bounds: { left: 40, top: 60, right: 80, bottom: 100 },
        };
        const selector = new FakeElementSelector(targetElement);
        h.screen.viewHierarchy = {
          ...h.screen.viewHierarchy,
          hierarchy: { node: { $: targetElement } },
        };
        const result =
          tool === "tapOn"
            ? await h
                .attach(
                  new TapOnElement(h.device, h.adb, {
                    ...h.deps,
                    tapStrategy,
                    hierarchyCapture: new FakeHierarchyCapture(() => h.screen.viewHierarchy!),
                    talkBackStrategy: strategy,
                    talkBackDriverFactory: factory,
                    elementSelector: selector,
                    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
                    waitForCondition: {
                      execute: async () => ({
                        matched: false,
                        candidates: [],
                        observation: h.screen,
                        polls: 1,
                        waitMs: 0,
                        timedOut: true,
                      }),
                    },
                  }),
                )
                .execute({ action: actionName, text: "Target" })
            : await (() => {
                const action = h.attach(
                  new TapAnyElement(h.device, null, {
                    ...h.deps,
                    talkBackStrategy: strategy,
                    talkBackDriverFactory: factory,
                    elementSelector: selector,
                  }),
                );
                let captures = 0;
                action.setRefreshViewHierarchyForTesting(async () =>
                  ++captures === 1 ? h.screen.viewHierarchy! : null,
                );
                return action.execute({ action: actionName });
              })();
        if (mode === "transition") {
          assertResult(result);
        } else {
          expect(result).toMatchObject({ success: true });
        }
        const count =
          mode === "transition"
            ? site === "precise-activation"
              ? 1
              : 0
            : site === "double-dispatch"
              ? 0
              : 1;
        expect(driver.tapHistory).toHaveLength(count);
        expect(driver.doubleTapHistory).toHaveLength(
          mode === "transition" || site === "longPress-fallback" ? 0 : 1,
        );
        expect(h.inputs()).toEqual([]);
        expect(h.taps()).toEqual([]);
      });
    }
  }
});

// Exercise the path executor independently; SwipeOn uses swipe(), not execute().
describe("ExecuteGesture path fences", () => {
  for (const site of ["android", "ios-single", "ios-multi"] as const) {
    test.each(modes)(`${site}: %s`, async (mode: Mode) => {
      const h = harness(site === "android" ? "android" : "ios", mode);
      const base = h.attach(new BaseVisualChange(h.device, h.adb, h.timer, undefined, h.deps));
      const gesture = new ExecuteGesture(h.device, h.adb, h.timer);
      let error: unknown;
      try {
        await base.observedInteraction(
          async (_observation, fence) => {
            await h.bump();
            return gesture.execute(
              site === "ios-multi"
                ? [
                    {
                      finger: 0,
                      points: [
                        { x: 10, y: 20 },
                        { x: 30, y: 40 },
                      ],
                    },
                    {
                      finger: 1,
                      points: [
                        { x: 20, y: 20 },
                        { x: 40, y: 40 },
                      ],
                    },
                  ]
                : [
                    { x: 10, y: 20 },
                    { x: 30, y: 40 },
                  ],
              300,
              undefined,
              { displayFence: fence },
            );
          },
          {
            changeExpected: false,
            skipUiStability: true,
            predictionContext: { toolName: "swipeOn", toolArgs: {} },
          },
        );
      } catch (caught) {
        error = caught;
      }
      if (mode === "transition") {
        expect(error).toBeInstanceOf(StaleDisplayError);
        if (!(error instanceof StaleDisplayError)) {
          throw new Error("Expected stale refusal");
        }
        assertResult({ success: false, error: error.message, staleDisplay: error.details });
      } else {
        expect(error).toBeUndefined();
      }
      const count = mode === "transition" ? 0 : 1;
      if (site === "android") {
        expect(h.inputs()).toEqual(count ? ["shell input swipe 10 20 30 40 300"] : []);
      } else if (site === "ios-single") {
        expect(h.ios.getSwipeHistory()).toHaveLength(count);
      } else {
        expect(h.ios.getMultiFingerSwipeHistory()).toHaveLength(count);
      }
    });
  }
});

describe("default-display recovery dispatches", () => {
  for (const tool of ["tapOn", "tapAny"] as const) {
    for (const site of ["longPress", "longPress-adb-fallback"] as const) {
      test.each(modes)(`${tool} ${site}: %s`, async (mode: Mode) => {
        const h = harness("android", mode);
        const element = {
          text: "Target",
          clickable: true,
          "long-clickable": true,
          bounds: { left: 40, top: 60, right: 80, bottom: 100 },
        } as Element;
        const selector = new FakeElementSelector(element);
        const tapStrategy = new FakeTapStrategy();
        if (site === "longPress") {
          watch(tapStrategy, "isAccessibilityServiceEnabled").mockImplementation(async () => {
            await h.bump();
            return false;
          });
          watch(h.detector, "detectMethod").mockImplementation(async () => {
            await h.bump();
            return "unknown";
          });
        } else {
          const execute = h.adb.executeCommand.bind(h.adb);
          watch(h.adb, "executeCommand").mockImplementation(
            async (...args: Parameters<typeof h.adb.executeCommand>) => {
              if (args[0].includes("input touchscreen swipe")) {
                await execute(...args);
                await h.bump();
                throw new Error("touchscreen source unavailable");
              }
              return execute(...args);
            },
          );
        }
        const result =
          tool === "tapOn"
            ? await h
                .attach(
                  new TapOnElement(h.device, h.adb, {
                    ...h.deps,
                    tapStrategy,
                    elementSelector: selector,
                    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
                    waitForCondition: {
                      execute: async () => ({
                        matched: false,
                        candidates: [],
                        observation: h.screen,
                        polls: 1,
                        waitMs: 0,
                        timedOut: true,
                      }),
                    },
                  }),
                )
                .execute({ action: "longPress", text: "Target", duration: 500 })
            : await (() => {
                const action = h.attach(
                  new TapAnyElement(h.device, null, {
                    ...h.deps,
                    elementSelector: selector,
                  }),
                );
                action.setRefreshViewHierarchyForTesting(async () => null);
                return action.execute({ action: "longPress", duration: 500 });
              })();
        if (mode === "transition") {
          assertResult(result);
        } else {
          expect(result).toMatchObject({ success: true });
        }
        const first = "shell input touchscreen swipe 60 80 60 80 500";
        const fallback = "shell input swipe 60 80 60 80 500";
        expect(h.inputs()).toEqual(
          mode === "transition"
            ? site === "longPress"
              ? []
              : [first]
            : site === "longPress"
              ? [first]
              : [first, fallback],
        );
        expect(h.taps()).toEqual([]);
      });
    }
  }
  test.each(modes)("DocumentsUI semantic recovery: %s", async (mode: Mode) => {
    const h = harness("android", mode);
    const selector = new FakeElementSelector({
      text: "Target",
      "resource-id": "com.android.documentsui:id/item_root",
      "unique-id": "row",
      actions: ["click"],
      clickable: true,
      bounds: { left: 40, top: 60, right: 80, bottom: 100 },
    } as Element);
    watch(AndroidCtrlProxyClient.prototype, "supportsNodeActionSelectors").mockResolvedValue(true);
    watch(AndroidCtrlProxyClient.prototype, "requestNodeAction").mockImplementation(async () => {
      await h.bump();
      return { success: false, action: "click" };
    });
    const result = await h
      .attach(
        new TapOnElement(h.device, h.adb, {
          ...h.deps,
          elementSelector: selector,
          tapStrategy: new FakeTapStrategy(),
          selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
          waitForCondition: {
            execute: async () => ({
              matched: false,
              candidates: [],
              observation: h.screen,
              polls: 1,
              waitMs: 0,
              timedOut: true,
            }),
          },
        }),
      )
      .execute({ action: "tap", text: "Target" });
    if (mode === "transition") {
      assertResult(result);
    } else {
      expect(result).toMatchObject({ success: true });
    }
    expect(h.inputs()).toEqual(mode === "transition" ? [] : ["shell input touchscreen tap 60 80"]);
    expect(h.taps()).toEqual([]);
  });
  test.each(modes)("VoiceOver failed activation coordinate fallback: %s", async (mode: Mode) => {
    const h = harness("ios", mode);
    const tapStrategy = new FakeTapStrategy();
    tapStrategy.setAccessibilityServiceEnabled(true);
    watch(IOSCtrlProxyClient.prototype, "requestVoiceOverActivate").mockImplementation(async () => {
      await h.bump();
      return { success: false, error: "activation unavailable" };
    });
    const result = await h
      .attach(
        new TapOnElement(h.device, h.adb, {
          ...h.deps,
          tapStrategy,
          selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
          waitForCondition: {
            execute: async () => ({
              matched: false,
              candidates: [],
              observation: h.screen,
              polls: 1,
              waitMs: 0,
              timedOut: true,
            }),
          },
        }),
      )
      .execute({ action: "tap", text: "Target" });
    if (mode === "transition") {
      assertResult(result);
    } else {
      expect(result).toMatchObject({ success: true });
    }
    expect(h.taps()).toEqual(mode === "transition" ? [] : [{ x: 60, y: 80, duration: 50 }]);
    expect(h.inputs()).toEqual([]);
  });
  for (const site of ["detection", "semantic-fallback"] as const) {
    test.each(modes)(`TalkBack two-finger swipe ${site}: %s`, async (mode: Mode) => {
      const h = harness("android", mode);
      if (site === "semantic-fallback") {
        h.screen.viewHierarchy!.hierarchy = {
          node: {
            node: [
              {
                $: {
                  text: "Target",
                  "resource-id": "container",
                  scrollable: true,
                  bounds: { left: 40, top: 60, right: 80, bottom: 100 },
                },
              },
            ],
          },
        };
        watch(AndroidCtrlProxyClient.prototype, "getAccessibilityHierarchy").mockResolvedValue(
          h.screen.viewHierarchy!,
        );
      }
      watch(h.detector, "detectMethod").mockImplementation(async () => {
        if (site === "detection") {
          await h.bump();
        }
        return "talkback";
      });
      watch(AndroidCtrlProxyClient.prototype, "requestAction").mockImplementation(async () => {
        if (site === "semantic-fallback") {
          await h.bump();
        }
        return { success: false, action: "scroll_forward" };
      });
      watch(AndroidCtrlProxyClient.prototype, "requestTwoFingerSwipe").mockImplementation(
        h.android.requestTwoFingerSwipe.bind(h.android),
      );
      const result = await h
        .attach(new SwipeOn(h.device, null, { ...h.deps, observeScreen: h.observe }))
        .execute({
          direction: "up",
          container: site === "semantic-fallback" ? { text: "Target" } : undefined,
          autoTarget: false,
        });
      if (mode === "transition") {
        assertResult(result);
      } else {
        expect(result).toMatchObject({ success: true });
      }
      expect(h.android.getTwoFingerSwipeHistory()).toHaveLength(mode === "transition" ? 0 : 1);
      expect(h.inputs()).toEqual([]);
    });
  }
  for (const platform of ["android", "ios"] as const) {
    test.each(modes)(
      `scroll-until-visible ${platform} retains earlier observation: %s`,
      async (mode: Mode) => {
        const h = harness(platform, mode);
        watch(AndroidCtrlProxyClient.prototype, "requestDeviceInfo").mockResolvedValue({
          success: true,
          sdkInt: 36,
          totalTimeMs: 0,
        });
        let detections = 0;
        watch(h.detector, "detectMethod").mockImplementation(async () => {
          if (++detections === 1) {
            await h.bump();
          }
          return "unknown";
        });
        watch(h.voiceOver, "resolveState").mockImplementation(async () => {
          await h.bump();
          return false;
        });
        h.observe.setObserveResult(() => {
          if (h.android.getDragHistory().length || h.ios.getSwipeHistory().length) {
            return {
              ...h.screen,
              viewHierarchy: {
                ...h.screen.viewHierarchy!,
                hierarchy: {
                  node: {
                    node: [
                      {
                        $: {
                          text: "Target",
                          scrollable: true,
                          bounds: { left: 40, top: 60, right: 80, bottom: 100 },
                        },
                        node: [
                          {
                            $: {
                              text: "Appeared",
                              bounds: { left: 45, top: 65, right: 55, bottom: 75 },
                            },
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            };
          }
          return h.screen;
        });
        const result = await h
          .attach(new SwipeOn(h.device, null, { ...h.deps, observeScreen: h.observe }))
          .execute({
            direction: "up",
            container: { text: "Target" },
            lookFor: { text: "Appeared", maxTime: 500 },
          });
        if (mode === "transition") {
          assertResult(result);
        } else {
          expect(result).toMatchObject({ success: true, found: true, scrollIterations: 1 });
        }
        if (platform === "android") {
          expect(h.android.getDragHistory()).toHaveLength(mode === "transition" ? 0 : 1);
          expect(h.inputs()).toEqual([]);
        } else {
          expect(h.ios.getSwipeHistory()).toHaveLength(mode === "transition" ? 0 : 1);
        }
      },
    );
  }
});

// Exercise the public seams directly, including the harness's untyped extra-argument shape.
describe("display fence options preserve public call shapes", () => {
  for (const entry of ["tap", "retry", "path", "coordinateFallback", "longPress"] as const) {
    test.each(["legacy", "fenced", "stale", "extra"] as const)(`${entry}: %s`, async (shape) => {
      const h = harness("android", "unchanged");
      const events: string[] = [];
      const stale = new StaleDisplayError({
        observedGeneration: 7,
        currentGeneration: 8,
        retry: "observe",
      });
      const displayFence = {
        assertCurrent() {
          events.push("fence");
          if (shape === "stale") {
            throw stale;
          }
        },
      };
      const options = shape === "fenced" || shape === "stale" ? { displayFence } : {};
      const element: Element = {
        clickable: true,
        bounds: { left: 40, top: 60, right: 80, bottom: 100 },
      };
      const dispatch = async () => {
        events.push("dispatch");
        return { success: true, totalTimeMs: 1 };
      };
      watch(AndroidCtrlProxyClient.prototype, "requestTapCoordinates").mockImplementation(dispatch);
      watch(h.adb, "executeCommand").mockImplementation(async () => {
        events.push("dispatch");
        return { stdout: "", stderr: "", toString: () => "", valueOf: () => "" };
      });
      const driver = new FakeTalkBackNavigationDriver();
      watch(driver, "requestTapCoordinates").mockImplementation(dispatch);
      const strategy = new TalkBackTapStrategy({ timer: h.timer });
      const tap = h.attach(new TapOnElement(h.device, h.adb, h.deps));
      const path = [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ];
      const gesture = new ExecuteGesture(h.device, h.adb, h.timer);
      const hierarchy = h.screen.viewHierarchy;
      if (!hierarchy) {
        throw new Error("Missing fake hierarchy");
      }
      Object.assign(tap, { refreshViewHierarchy: async () => hierarchy });
      const hash = hierarchyFingerprint(hierarchy);
      if (!hash) {
        throw new Error("Missing fake hierarchy fingerprint");
      }
      let invoke: () => Promise<unknown>;
      switch (entry) {
        case "tap":
          invoke =
            shape === "extra"
              ? () =>
                  Reflect.apply(tap.executeAndroidTap, tap, [
                    "tap",
                    50,
                    70,
                    50,
                    element,
                    undefined,
                    undefined,
                    false,
                    [],
                  ])
              : shape === "legacy"
                ? () => tap.executeAndroidTap("tap", 50, 70, 50, element)
                : () =>
                    tap.executeAndroidTap(
                      "tap",
                      50,
                      70,
                      50,
                      element,
                      undefined,
                      { action: "tap", ...options },
                      false,
                    );
          break;
        case "retry": {
          const args: Parameters<TapOnElement["retryTapIfNoChange"]> = [
            hash,
            { x: 50, y: 70 },
            "tap",
            50,
            element,
            { action: "tap", ...options },
            false,
            h.screen.screenSize,
          ];
          invoke =
            shape === "extra"
              ? () =>
                  Reflect.apply(tap.retryTapIfNoChange, tap, [...args, undefined, undefined, []])
              : () => tap.retryTapIfNoChange(...args);
          break;
        }
        case "path":
          invoke =
            shape === "extra"
              ? () => Reflect.apply(gesture.execute, gesture, [path, 300, undefined, []])
              : shape === "legacy"
                ? () => gesture.execute(path, 300)
                : () => gesture.execute(path, 300, undefined, options);
          break;
        case "coordinateFallback":
          invoke =
            shape === "extra"
              ? () =>
                  Reflect.apply(strategy.executeCoordinateFallback, strategy, [
                    50,
                    70,
                    "longPress",
                    500,
                    driver,
                    [],
                  ])
              : shape === "legacy"
                ? () => strategy.executeCoordinateFallback(50, 70, "longPress", 500, driver)
                : () =>
                    strategy.executeCoordinateFallback(50, 70, "longPress", 500, driver, options);
          break;
        case "longPress":
          invoke =
            shape === "extra"
              ? () =>
                  Reflect.apply(strategy.executeLongPress, strategy, [
                    50,
                    70,
                    500,
                    element,
                    driver,
                    [],
                  ])
              : shape === "legacy"
                ? () => strategy.executeLongPress(50, 70, 500, element, driver)
                : () => strategy.executeLongPress(50, 70, 500, element, driver, options);
          break;
      }
      if (shape === "stale") {
        await expect(invoke()).rejects.toBe(stale);
        expect(events).toEqual(["fence"]);
      } else {
        await invoke();
        expect(events).toEqual(shape === "fenced" ? ["fence", "dispatch"] : ["dispatch"]);
      }
    });
  }
});

test("review: explicit adb search preserves the default-display dispatch fence", async () => {
  const h = harness("android", "unchanged");
  watch(AndroidCtrlProxyClient.prototype, "requestDeviceInfo").mockResolvedValue({
    success: true,
    sdkInt: 36,
    totalTimeMs: 0,
  });
  let checks = 0;
  const gesture = new ExecuteGesture(h.device, h.adb, h.timer);
  expect(
    await gesture.swipe(50, 180, 50, 20, {
      searchScroll: true,
      scrollMode: "adb",
      duration: 1,
      searchScrollBounds: { left: 0, top: 0, right: 100, bottom: 200 },
      displayFence: {
        assertCurrent: () => {
          checks++;
        },
      },
    }),
  ).toMatchObject({ success: true });
  expect(h.inputs()).toEqual(["shell input swipe 50 180 50 30 600"]);
  expect(h.android.getDragHistory()).toEqual([]);
  expect(checks).toBeGreaterThan(0);
});

for (const tool of ["tapOn", "tapAny"] as const) {
  test.each(["unchanged", "transition"] as const)(
    `review cache-hit ${tool} revalidation preserves default-display fence: %s`,
    async (mode) => {
      const h = harness("android", mode);
      watch(h.observe, "getMostRecentCachedObserveResult").mockResolvedValue({
        ...h.screen,
        freshness: { isFresh: true },
      });
      const timeouts: number[] = [];
      const refresh = async (timeout: number) => {
        timeouts.push(timeout);
        h.timer.advanceTime(1200);
        await h.bump();
        return h.screen.viewHierarchy!;
      };
      const on = h.attach(
        new TapOnElement(h.device, h.adb, {
          ...h.deps,
          observeScreen: h.observe,
          tapStrategy: new FakeTapStrategy(),
          selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
        }),
      );
      on.refreshViewHierarchy = refresh;
      const any = h.attach(
        new TapAnyElement(h.device, h.adb, { ...h.deps, observeScreen: h.observe }),
      );
      any.setRefreshViewHierarchyForTesting(async (_defaultRefresh, timeout) => refresh(timeout));
      const options = {
        text: "Target",
        action: "longPress" as const,
        duration: 100,
        retryIfNoChange: false,
        selectionStrategy: "first" as const,
      };
      const result = tool === "tapOn" ? await on.execute(options) : await any.execute(options);
      expect(timeouts).toEqual([15000]);
      if (mode === "transition") {
        assertResult(result);
        expect(h.inputs()).toEqual([]);
      } else {
        expect(result.success).toBe(true);
        expect(h.inputs()).toEqual([
          tool === "tapOn"
            ? "shell input touchscreen swipe 60 80 60 80 100"
            : "shell input touchscreen swipe 20 30 20 30 100",
        ]);
      }
      expect(h.taps()).toEqual([]);
    },
  );
}
