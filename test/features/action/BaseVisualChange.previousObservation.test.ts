import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { SendKeys } from "../../../src/features/action/SendKeys";
import { FakeScreenshotCapturer } from "../../fakes/FakeScreenshotCapturer";
import { FakeVisionAnalyzer } from "../../fakes/FakeVisionAnalyzer";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { SwipeOn } from "../../../src/features/action/swipeon";
import { RealSettleObserve } from "../../../src/features/observe/SettleObserve";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import {
  markWindowResolutionRequired,
  pendingWindowResolutionGeneration,
  resetObserveCacheStore,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import {
  ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV,
  OBSERVE_SETTLED_SCREENSHOT_ENV,
} from "../../../src/features/observe/automaticScreenshotPolicy";
import { settleEmbeddedObservationInResponse } from "../../../src/server/embeddedObservationSettle";
import {
  deferTerminalScreenshot,
  runWithPostActionCaptureScope,
} from "../../../src/utils/PostActionCaptureContext";
import { createStructuredToolResponse, getStructuredField } from "../../../src/utils/toolUtils";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import type { ObserveResult } from "../../../src/models";
import { defaultAdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeGestureExecutor } from "../../fakes/FakeGestureExecutor";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import {
  createHierarchyForTest,
  createObserveScreenForTest,
} from "../observe/observeScreenTestBuilders";

const device = { deviceId: "previous-observe-trace", name: "Trace", platform: "android" } as const;
type Phase = "observe" | "before" | "action" | "settle" | "terminal";

function harness(initiallyVerified = true, revealAfterAction = false) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_700_000_000_000);
  timer.enableAutoAdvance();
  const adb = new FakeAdbExecutor();
  const factory = new FakeAdbClientFactory(adb);
  spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
  const cache = new FakeObserveCacheStore(timer);
  const screenshotState = new FakeScreenshotStateStore(timer);
  let phase: Phase = "observe";
  const captures: Phase[] = [];
  const reads: Phase[] = [];
  class Recorder extends FakeScreenshotRecorder {
    override start() {
      captures.push(phase);
      super.start();
    }
    override async capture() {
      captures.push(phase);
      await super.capture();
    }
    override async captureFresh() {
      captures.push(phase);
      await super.captureFresh();
    }
    override async captureSettled(observationId: string) {
      captures.push(phase);
      const path = await super.captureSettled(observationId);
      screenshotState.updateForObservation(device.deviceId, observationId, path, undefined, {
        width: 1080,
        height: 1920,
      });
      return path;
    }
  }
  const source = new FakeViewHierarchy();
  let readCount = 0;
  const read = () => {
    readCount++;
    reads.push(phase);
    timer.advanceTime(1);
    adb.setDeviceTimestampMs(timer.now());
    return createHierarchyForTest({
      updatedAt: timer.now(),
      receivedAt: timer.now(),
      fresh: readCount === 1 ? initiallyVerified : true,
      screenWidth: 1080,
      screenHeight: 1920,
      packageName: "com.example",
      foregroundActivity: "com.example/.MainActivity",
      wakefulness: "Awake",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          node: [
            {
              text: "Regular Button",
              class: "android.widget.Button",
              clickable: true,
              enabled: true,
              bounds: { left: 100, top: 200, right: 300, bottom: 300 },
            },
            ...(revealAfterAction && phase === "action"
              ? [
                  {
                    text: "Revealed Item",
                    class: "android.widget.Button",
                    clickable: true,
                    enabled: true,
                    bounds: { left: 100, top: 800, right: 300, bottom: 900 },
                  },
                ]
              : []),
          ],
        },
      },
    });
  };
  source.getViewHierarchy = async () => read();
  const capture = new FakeHierarchyCapture(read);
  const window = new FakeWindow();
  window.configureActiveWindow({
    appId: "com.example",
    activityName: ".MainActivity",
    layoutSeqSum: 0,
  });
  const audits: Phase[] = [];
  const audit = {
    run: async () => {
      audits.push(phase);
    },
  };
  const recorder = new Recorder();
  const screen = createObserveScreenForTest(
    device,
    factory,
    {
      viewHierarchy: source,
      hierarchyCapture: capture,
      window,
      backStack: {
        execute: async () => ({ depth: 0, activities: [], tasks: [], capturedAt: timer.now() }),
      },
      cacheStore: cache,
      screenshotStateStore: screenshotState,
      screenshotRecorder: recorder,
      screenshotPathProtection: new FakeScreenshotPathProtection(timer),
      screenshotEvidenceFiles: {
        stat: async () => ({ isFile: () => true, size: 1, mtimeMs: timer.now() }),
      },
      accessibilityAuditor: audit,
    },
    timer,
  );
  const execute = spyOn(screen, "execute");

  const attach = <T extends BaseVisualChange>(action: T): T => {
    action.observeScreen = screen;
    const idle = new FakeAwaitIdle();
    action.awaitIdle.initializeUiStabilityTracking = idle.initializeUiStabilityTracking.bind(idle);
    action.awaitIdle.waitForUiStability = idle.waitForUiStability.bind(idle);
    action.awaitIdle.waitForUiStabilityWithState = idle.waitForUiStabilityWithState.bind(idle);
    action.window.getCachedActiveWindow = window.getCachedActiveWindow.bind(window);
    return action;
  };
  const tap = attach(
    new TapOnElement(device, adb, {
      timer,
      tapStrategy: new FakeTapStrategy(),
      hierarchyCapture: capture,
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    }),
  );
  tap.executeAndroidTap = async () => {
    phase = "action";
  };
  const gesture = new FakeGestureExecutor();
  const swipe = gesture.swipe.bind(gesture);
  gesture.swipe = async (...args) => {
    phase = "action";
    return swipe(...args);
  };
  const accessibility = new FakeAccessibilityDetector();
  accessibility.setTalkBackEnabled(false);
  const swipeAction = attach(
    new SwipeOn(device, null, {
      timer,
      observeScreen: screen,
      executeGesture: gesture,
      accessibilityDetector: accessibility,
    }),
  );
  const base = attach(new BaseVisualChange(device, adb, timer));
  const settle = new RealSettleObserve(screen, timer);
  const settleExecute = settle.execute.bind(settle);
  settle.execute = async (...args) => {
    phase = "settle";
    const result = await settleExecute(...args);
    phase = "terminal";
    return result;
  };
  return {
    timer,
    screen,
    cache,
    captures,
    reads,
    execute,
    audits,
    tap,
    swipeAction,
    base,
    recorder,
    adb,
    factory,
    setPhase: (next: Phase) => {
      phase = next;
    },
    async observe() {
      const result = await screen.execute();
      phase = "before";
      captures.length = 0;
      reads.length = 0;
      execute.mockClear();
      audits.length = 0;
      return result;
    },
    async run(
      name: "tapOn" | "swipeOn" | "sendKeys",
      fail = false,
      swipeOptions: Parameters<SwipeOn["execute"]>[0] = { direction: "up", autoTarget: false },
      expectSuccess = !fail,
    ) {
      return runWithPostActionCaptureScope(undefined, async () => {
        // sendKeys does not inherit BaseVisualChange. Exercise the shared action
        // contract explicitly; its production selector focus delegates to tapOn.
        const result =
          name === "tapOn" && !fail
            ? await tap.execute({ action: "tap", text: "Regular Button" })
            : name === "swipeOn" && !fail
              ? await swipeAction.execute(swipeOptions)
              : await base.observedInteraction(
                  async () => {
                    phase = "action";
                    return fail ? { success: false, error: "dispatch failed" } : { success: true };
                  },
                  { changeExpected: false, predictionContext: { toolName: name, toolArgs: {} } },
                );
        if (expectSuccess) {
          expect(result.success).toBe(true);
        }
        const response = createStructuredToolResponse(result);
        phase = "terminal";
        await settleEmbeddedObservationInResponse(response, {
          name,
          internal: false,
          createSettleObserve: () => settle,
          args: name === "sendKeys" ? { commands: [{ action: "key", key: "enter" }] } : {},
        });
        return getStructuredField<ObserveResult>(response, "observation");
      });
    },
  };
}

let ctrlProxySpy: ReturnType<typeof spyOn>;
let originalMode: string | undefined;
let originalActionPolicy: string | undefined;
beforeEach(() => {
  ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    new FakeCtrlProxy() as AndroidCtrlProxyClient,
  );
  originalMode = process.env[OBSERVE_SETTLED_SCREENSHOT_ENV];
  originalActionPolicy = process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV];
  process.env[OBSERVE_SETTLED_SCREENSHOT_ENV] = "1";
  process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV] = "0";
  serverConfig.setAccessibilityAuditConfig(null);
});
afterEach(() => {
  ctrlProxySpy.mockRestore();
  spyOn(defaultAdbClientFactory, "create").mockRestore();
  if (originalMode === undefined) {
    delete process.env[OBSERVE_SETTLED_SCREENSHOT_ENV];
  } else {
    process.env[OBSERVE_SETTLED_SCREENSHOT_ENV] = originalMode;
  }
  if (originalActionPolicy === undefined) {
    delete process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV];
  } else {
    process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV] = originalActionPolicy;
  }
  resetObserveCacheStore();
  resetScreenshotStateStore();
  displayTransitions.reset(device.deviceId);
});

describe("BaseVisualChange previous observation with real ObserveScreen", () => {
  test("async automatic screenshot skip remains effective after a resolution refetch", async () => {
    process.env[OBSERVE_SETTLED_SCREENSHOT_ENV] = "0";
    delete process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV];
    const h = harness(false);
    await h.observe();
    await h.run("tapOn");
    console.log(`async automatic skip: captures=${JSON.stringify(h.captures)}`);
    expect(h.captures).toEqual([]);
  });

  test("default async observe -> tapOn refetch does not start a pre-action capture", async () => {
    process.env[OBSERVE_SETTLED_SCREENSHOT_ENV] = "0";
    const h = harness(false);
    expect((await h.observe()).freshness).toMatchObject({
      isFresh: false,
      category: "cache_age",
      ageMs: 0,
    });
    await h.run("tapOn");
    console.log(`async tapOn: captures=${JSON.stringify(h.captures)}`);
    expect(h.captures).toEqual(["terminal"]);
    expect(h.reads.filter((phase) => phase === "before")).toHaveLength(1);
  });

  test.each(["tapOn", "swipeOn", "sendKeys"] as const)(
    "unverified observe -> %s shared resolution captures only terminal evidence",
    async (name) => {
      const h = harness(false);
      const initial = await h.observe();
      expect(initial.freshness).toMatchObject({ isFresh: false, category: "cache_age", ageMs: 0 });
      const cached = await h.screen.getMostRecentCachedObserveResult();
      expect(cached.freshness).toMatchObject({ isFresh: false, category: "cache_age", ageMs: 0 });
      expect(pendingWindowResolutionGeneration(device.deviceId)).toBeUndefined();
      const result = await h.run(name);
      console.log(
        `${name}: captures=${JSON.stringify(h.captures)}, reads=${JSON.stringify(h.reads)}`,
      );
      expect(h.captures).toEqual(["terminal"]);
      expect(h.reads.filter((phase) => phase === "before")).toHaveLength(1);
      expect(result?.screenshotPath).toBe("/fake/settled.png");
      expect(h.execute.mock.calls[0]?.[0]).toMatchObject({
        freshness: "fresh",
        skipScreenshot: true,
        skipAccessibilityAudit: true,
      });
    },
  );

  test("verified observe -> tapOn reuses the hierarchy without a pre-action capture", async () => {
    const h = harness();
    expect((await h.observe()).freshness?.isFresh).toBe(true);
    await h.run("tapOn");
    expect(h.reads.filter((phase) => phase === "before")).toHaveLength(1);
    expect(h.execute.mock.calls.some(([options]) => options?.freshness === "cached-ok")).toBe(
      false,
    );
    expect(h.captures).toEqual(["terminal"]);
  });

  test.each([
    ["plain swipe", { direction: "up" }],
    ["screen swipe", { direction: "up", autoTarget: false }],
    ["auto-targeted swipe", { direction: "up", autoTarget: true }],
    ["container swipe", { direction: "up", container: { text: "Regular Button" } }],
  ] as const)(
    "verified observe -> %s reads the hierarchy again without a capture before the gesture",
    async (_name, swipeOptions) => {
      const h = harness();
      expect((await h.observe()).freshness?.isFresh).toBe(true);
      await h.run("swipeOn", false, swipeOptions);
      expect(h.captures).toEqual(["terminal"]);
    },
  );

  test("verified observe -> lookFor swipe captures only terminal evidence", async () => {
    const h = harness(true, true);
    await h.observe();
    const result = await h.run("swipeOn", false, {
      direction: "up",
      lookFor: { text: "Revealed Item" },
      maxScrolls: 2,
    });
    expect(h.captures).toEqual(["terminal"]);
    expect(result?.screenshotPath).toBe("/fake/settled.png");
  });

  test("aged cache -> tapOn refetches without capturing before dispatch", async () => {
    const h = harness();
    await h.observe();
    h.timer.advanceTime(120_000);
    expect((await h.screen.getMostRecentCachedObserveResult()).freshness).toMatchObject({
      isFresh: false,
      category: "cache_age",
    });
    await h.run("tapOn");
    console.log(`aged tapOn: captures=${JSON.stringify(h.captures)}`);
    expect(h.captures).toEqual(["terminal"]);
    expect(h.reads.filter((phase) => phase === "before")).toHaveLength(1);
  });

  test("a slow just-completed verified observe can already exceed the cache age budget", async () => {
    const h = harness();
    const capture = h.recorder.captureSettled.bind(h.recorder);
    let first = true;
    h.recorder.captureSettled = async (observationId) => {
      if (first) {
        first = false;
        h.timer.advanceTime(120_000);
      }
      return capture(observationId);
    };
    expect((await h.observe()).freshness).toMatchObject({
      isFresh: true,
      verified: true,
      ageMs: 120_000,
    });
    expect((await h.screen.getMostRecentCachedObserveResult()).freshness).toMatchObject({
      isFresh: false,
      category: "cache_age",
      ageMs: 120_000,
    });
    await h.run("tapOn");
    console.log(`slow completed observe: captures=${JSON.stringify(h.captures)}`);
    expect(h.captures).toEqual(["terminal"]);
    expect(h.reads.filter((phase) => phase === "before")).toHaveLength(1);
  });

  test.each(["missing", "errored", "pending", "fallback"] as const)(
    "%s previous-observation refetch is hierarchy-only",
    async (reason) => {
      const h = harness();
      const initial = await h.observe();
      if (reason === "missing") {
        h.cache.clear(device.deviceId);
      }
      if (reason === "errored") {
        await h.cache.put(device.deviceId, {
          ...initial,
          viewHierarchy: { hierarchy: { error: "read failed" } },
        });
      }
      if (reason === "pending") {
        markWindowResolutionRequired(device.deviceId);
      }
      if (reason === "fallback") {
        spyOn(h.screen, "getMostRecentCachedObserveResult").mockRejectedValueOnce(
          new Error("cache read failed"),
        );
      }
      await h.run("tapOn");
      console.log(`${reason}: captures=${JSON.stringify(h.captures)}`);
      expect(h.captures).toEqual(["terminal"]);
      expect(h.reads.filter((phase) => phase === "before")).toHaveLength(1);
      expect(h.audits).toEqual(["terminal"]);
    },
  );

  test("failure retains its terminal screenshot without a resolution screenshot", async () => {
    const h = harness(false);
    await h.observe();
    const result = await h.run("tapOn", true);
    console.log(`failure: captures=${JSON.stringify(h.captures)}`);
    expect(h.captures).toEqual(["terminal"]);
    expect(result?.screenshotPath).toBe("/fake/settled.png");
  });

  test("observe -> SendKeys without a selector captures once after command dispatch", async () => {
    process.env[OBSERVE_SETTLED_SCREENSHOT_ENV] = "0";
    const h = harness();
    await h.observe();
    const sendKeys = new SendKeys(device, h.factory, {
      timer: h.timer,
      observer: h.screen,
      timestampProvider: { now: async () => h.timer.now() },
      executor: {
        type: async () => {
          expect(h.captures).toEqual([]);
          h.setPhase("action");
          return { index: 0, action: "type", success: true };
        },
        key: async () => ({ index: 0, action: "key", success: true }),
        clear: async () => ({ success: true }),
      },
    });
    const result = await sendKeys.execute([{ action: "type", text: "hello" }]);
    console.log(`standalone SendKeys: captures=${JSON.stringify(h.captures)}`);
    expect(result.success).toBe(true);
    expect(h.captures).toEqual(["action"]);
    expect(result.observation?.screenshotCaptureAttempted).toBe(true);
  });

  test("vision fallback captures its own evidence when the resolution observation has none", async () => {
    const h = harness(false);
    await h.observe();
    const capturer = new FakeScreenshotCapturer();
    capturer.setPaths(["/vision.png"]);
    const analyzer = new FakeVisionAnalyzer();
    const tap = new TapOnElement(device, h.adb, {
      timer: h.timer,
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: true },
      screenshotCapturer: capturer,
      visionAnalyzer: analyzer,
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    });
    let previousCaptureAttempted: boolean | undefined;
    await expect(
      h.base.observedInteraction(
        async (previous) => {
          previousCaptureAttempted = previous.screenshotCaptureAttempted;
          return tap["handleElementNotFound"]({ action: "tap", text: "Missing" }, previous, true);
        },
        { changeExpected: false },
      ),
    ).rejects.toThrow("Element not found");
    console.log(
      `vision: observationCaptures=${JSON.stringify(h.captures)}, visionCaptures=${capturer.getCallCount()}`,
    );
    expect(previousCaptureAttempted).toBe(false);
    expect(h.captures).toEqual([]);
    expect(capturer.getCallCount()).toBe(1);
    expect(analyzer.getCalls()[0]?.screenshotPath).toBe("/vision.png");
  });

  test("an explicit async observe may still be in flight; cache reads do not start another capture", async () => {
    process.env[OBSERVE_SETTLED_SCREENSHOT_ENV] = "0";
    const h = harness();
    const completion = Promise.withResolvers<void>();
    const start = h.recorder.start.bind(h.recorder);
    let completed = false;
    h.recorder.start = () => {
      start();
      void completion.promise.then(() => {
        completed = true;
      });
    };
    await h.observe();
    expect(h.recorder.startCalls).toBe(1);
    expect(completed).toBe(false);
    expect((await h.screen.getMostRecentCachedObserveResult()).freshness?.isFresh).toBe(true);
    expect(h.captures).toEqual([]);
    expect(h.reads).toEqual([]);
    completion.resolve();
    await completion.promise;
    expect(completed).toBe(true);
    await h.run("tapOn");
    expect(h.captures).toEqual(["terminal"]);
  });

  test("reading a cache entry with deferred evidence does not start its capture", async () => {
    const h = harness();
    const initial = await h.observe();
    delete initial.screenshotPath;
    await h.cache.put(device.deviceId, initial);
    await runWithPostActionCaptureScope(undefined, async () => {
      expect(
        deferTerminalScreenshot(initial, async () => {
          h.captures.push("terminal");
        }),
      ).toBe(true);
      const cached = await h.screen.getMostRecentCachedObserveResult();
      expect(cached.freshness?.isFresh).toBe(true);
      expect(h.captures).toEqual([]);
      expect(h.reads).toEqual([]);
    });
    expect(h.captures).toEqual(["terminal"]);
  });

  test("a previous action's deferred evidence flushes before the next action in the same scope", async () => {
    const h = harness();
    const initial = await h.observe();
    await runWithPostActionCaptureScope(undefined, async () => {
      expect(
        deferTerminalScreenshot(initial, async () => {
          h.captures.push("before");
        }),
      ).toBe(true);
      await h.base.observedInteraction(
        async () => {
          expect(h.captures).toEqual(["before"]);
          h.setPhase("action");
          return { success: true };
        },
        { changeExpected: false },
      );
      h.setPhase("terminal");
    });
    expect(h.captures).toEqual(["before", "action"]);
  });
});
