import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SendKeys } from "../../../src/features/action/SendKeys";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { prepareTargetDisplayAction } from "../../../src/features/action/TargetDisplayAction";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import {
  ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV,
  OBSERVE_SETTLED_SCREENSHOT_ENV,
} from "../../../src/features/observe/automaticScreenshotPolicy";
import type {
  ObserveScreenExecuteOptions,
  ObserveScreen,
} from "../../../src/features/observe/interfaces/ObserveScreen";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { HierarchyCapture } from "../../../src/features/observe/HierarchyCapture";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createObserveScreenForTest } from "../observe/observeScreenTestBuilders";

const device = {
  deviceId: "pre-dispatch-capture-android",
  platform: "android",
  name: "Android",
  displays: {
    panels: [
      { key: "internal", role: "inner", sizePx: { width: 200, height: 200 } },
      { key: "external", role: "external", sizePx: { width: 200, height: 200 } },
    ],
    postures: [],
  },
} as BootedDevice;

type Phase = "before" | "after";

/**
 * Mirrors RealObserveScreen's capture policy: a read without skipScreenshot captures, and one
 * without skipAccessibilityAudit audits. A phase flips to "after" at the first input dispatch.
 */
class CountingObserveScreen extends FakeObserveScreen {
  phase: Phase = "before";
  readonly captures: Phase[] = [];
  readonly audits: Phase[] = [];
  readonly reads: Array<{ phase: Phase; options: ObserveScreenExecuteOptions }> = [];

  override async execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    this.reads.push({ phase: this.phase, options: options ?? {} });
    if (!options?.skipScreenshot) {
      this.captures.push(this.phase);
    }
    if (!options?.skipAccessibilityAudit) {
      this.audits.push(this.phase);
    }
    return super.execute(options);
  }

  override async captureScreenshot(
    ...args: Parameters<NonNullable<ObserveScreen["captureScreenshot"]>>
  ): Promise<void> {
    this.captures.push(this.phase);
    return super.captureScreenshot(...args);
  }
}

/** Display 0 dispatches through CtrlProxy; its first tap or swipe is the dispatch boundary. */
class PhaseCtrlProxy extends FakeCtrlProxy {
  constructor(private readonly observe: CountingObserveScreen) {
    super();
  }

  override async requestTapCoordinates(
    ...args: Parameters<FakeCtrlProxy["requestTapCoordinates"]>
  ) {
    this.observe.phase = "after";
    return super.requestTapCoordinates(...args);
  }

  override async requestSwipe(...args: Parameters<FakeCtrlProxy["requestSwipe"]>) {
    this.observe.phase = "after";
    return super.requestSwipe(...args);
  }
}

function screen(key: string): ObserveResult {
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
        node: {
          text: "Settings",
          clickable: true,
          bounds: { left: 20, top: 30, right: 80, bottom: 90 },
        },
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
      'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 200 x 200}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
    stderr: "",
  });
  return result;
}

function autoTimer(): FakeTimer {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
}

/** The first input command is the dispatch boundary; everything counted after it is post-action. */
function markDispatch(executor: FakeAdbExecutor, observe: CountingObserveScreen) {
  const executeCommand = executor.executeCommand.bind(executor);
  return spyOn(executor, "executeCommand").mockImplementation(async (...args) => {
    if (args[0].includes("input")) {
      observe.phase = "after";
    }
    return executeCommand(...args);
  });
}

type Run = (
  key: string,
  executor: FakeAdbExecutor,
  observe: CountingObserveScreen,
) => Promise<{ success: boolean }>;

const rendered = (key: string) => () => ({ display: { key, generation: 1 } });

const actions: Record<string, Run> = {
  tapAt: async (key, executor, observe) => {
    const action = new TapAtCoordinate(device, executor, {
      timer: autoTimer(),
      lastRenderedObservation: rendered(key),
    });
    action.observeScreen = observe;
    return action.execute({ x: 50, y: 60, display: key });
  },
  tapOn: async (key, executor, observe) => {
    const action = new TapOnElement(device, executor, {
      timer: autoTimer(),
      lastRenderedObservation: rendered(key),
    });
    action.observeScreen = observe;
    return action.execute({ text: "Settings", action: "tap", display: key });
  },
  swipeOn: async (key, executor, observe) =>
    new SwipeOn(device, executor as unknown as AdbClient, {
      timer: autoTimer(),
      observeScreen: observe,
      lastRenderedObservation: rendered(key),
    }).execute({ direction: "up", display: key }),
  sendKeys: async (key, executor, observe) =>
    new SendKeys(device, new FakeAdbClientFactory(executor), {
      timer: autoTimer(),
      observer: observe,
      timestampProvider: { now: async () => 1 },
      lastRenderedObservation: rendered(key),
    }).execute([{ action: "key", key: "enter" }], undefined, undefined, undefined, key),
};

let proxySpies: Array<ReturnType<typeof spyOn>> = [];
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
  displayTransitions.reset(device.deviceId);
  // Capture on every read that does not opt out, so a stray pre-dispatch capture is visible.
  for (const [name, value] of [
    [ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV, "0"],
    [OBSERVE_SETTLED_SCREENSHOT_ENV, "0"],
  ] as const) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
});
afterEach(() => {
  for (const spy of proxySpies) {
    spy.mockRestore();
  }
  proxySpies = [];
  for (const [name, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  savedEnv.clear();
  displayTransitions.reset(device.deviceId);
});

describe("explicit-display pre-dispatch read", () => {
  test.each(["internal", "external"] as const)(
    "prepareTargetDisplayAction on %s reads hierarchy only",
    async (key) => {
      const observe = new CountingObserveScreen();
      observe.setObserveResult(screen(key));
      await prepareTargetDisplayAction(
        device,
        key,
        observe,
        adb(),
        rendered(key),
        undefined,
        undefined,
      );
      expect(observe.captures).toEqual([]);
      expect(observe.audits).toEqual([]);
      expect(observe.reads).toHaveLength(1);
      expect(observe.reads[0]?.options).toMatchObject({
        display: key,
        freshness: "cached-ok",
        skipScreenshot: true,
        skipAccessibilityAudit: true,
      });
    },
  );

  test.each(["internal", "external"] as const)(
    "RealObserveScreen starts no capture and no audit for the %s pre-dispatch read",
    async (key) => {
      const target = { ...device, deviceId: `pre-dispatch-real-${key}` };
      ObservedAndroidDisplayCache.release(target.deviceId);
      const timer = autoTimer();
      const recorder = new FakeScreenshotRecorder();
      let audits = 0;
      const displayId = key === "external" ? 2 : 0;
      const capture: HierarchyCapture = {
        capture: async (request) => ({
          captureId: "pre-dispatch",
          platform: "android",
          requestedFreshness: request.freshness,
          receivedAt: 0,
          nodes: [],
          hierarchy: {
            hierarchy: { node: {} },
            displayId,
            screenWidth: 200,
            screenHeight: 200,
          },
        }),
      };
      // The real-screen path configures recomposition tracking on the device's
      // CtrlProxy client; stub it so this test never opens a real WebSocket (#10470).
      const recomposition = spyOn(
        AndroidCtrlProxyClient.prototype,
        "setRecompositionTrackingEnabled",
      ).mockResolvedValue(undefined);
      const screen = createObserveScreenForTest(
        target,
        new FakeAdbClientFactory(adb()),
        {
          hierarchyCapture: capture,
          cacheStore: new FakeObserveCacheStore(timer),
          screenshotRecorder: recorder,
          accessibilityAuditor: {
            run: async () => {
              audits++;
            },
          },
        },
        timer,
      );
      try {
        const prepared = await prepareTargetDisplayAction(
          target,
          key,
          screen,
          adb(),
          rendered(key),
          undefined,
          undefined,
        );
        expect(prepared.observation.display.key).toBe(key);
        expect(prepared.displayId).toBe(displayId);
        expect(recorder.startCalls + recorder.captureCalls).toBe(0);
        expect(recorder.captureFreshCalls + recorder.captureSettledCalls).toBe(0);
        expect(audits).toBe(0);
      } finally {
        recomposition.mockRestore();
        ObservedAndroidDisplayCache.release(target.deviceId);
        displayTransitions.reset(target.deviceId);
        resetObserveCacheStore();
      }
    },
  );

  for (const name of Object.keys(actions)) {
    for (const key of ["internal", "external"] as const) {
      test(`${name} on ${key} takes no screenshot or audit before dispatch`, async () => {
        const executor = adb();
        const observe = new CountingObserveScreen();
        observe.setObserveResult(screen(key));
        const spy = markDispatch(executor, observe);
        const proxy = new PhaseCtrlProxy(observe) as AndroidCtrlProxyClient;
        proxySpies.push(
          spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(proxy),
          spyOn(AndroidCtrlProxyClient, "getExistingInstance").mockReturnValue(proxy),
        );
        const result = await actions[name]!(key, executor, observe);
        spy.mockRestore();
        expect(result).toMatchObject({ success: true });
        expect(observe.phase).toBe("after");
        // Nothing is captured or audited before dispatch; exactly one capture follows it.
        expect(observe.captures).toEqual(["after"]);
        expect(observe.audits.filter((phase) => phase === "before")).toEqual([]);
      });
    }
  }
});
