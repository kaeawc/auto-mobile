import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { describe, expect, test, spyOn, mock } from "bun:test";
import { LONG_PRESS_HARD_MAX_MS } from "../../../src/features/action/tapAtGesture";
import {
  AdbClient,
  AdbCommandTimeoutError,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { logger } from "../../../src/utils/logger";
import type { Element } from "../../../src/models";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeTalkBackTapStrategy } from "../../fakes/FakeTalkBackTapStrategy";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import {
  getHierarchySnapshot,
  identifyObservedHierarchy,
  inheritHierarchySnapshot,
} from "../../../src/features/observe/HierarchyCapture";
import type {
  A11yTapCoordinatesResult,
  AccessibilityNodeSelector,
} from "../../../src/features/observe/android/types";

const createTapAnyElement = (selector: FakeElementSelector) => {
  return new TapAnyElement(
    {
      name: "test-device",
      platform: "android",
      deviceId: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    {
      timer: new FakeTimer(),
      elementSelector: selector,
    },
  );
};

const makeElement = () =>
  ({
    bounds: { left: 10, top: 20, right: 110, bottom: 70 },
    text: "ListItem",
    clickable: "true",
  }) as any;

describe("TapAnyElement", () => {
  test("budgets the maximum Android long press beyond the default ADB timeout", async () => {
    const adb = new FakeAdbClient();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tapAny = new TapAnyElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" },
      adb as any,
      { timer, elementSelector: new FakeElementSelector(makeElement()) },
    );
    tapAny.setRefreshViewHierarchyForTesting(async () => null);
    tapAny.observedInteraction = (action) =>
      action(
        recordObservationRead({
          viewHierarchy: { hierarchy: { node: {} } },
          screenSize: { width: 500, height: 500 },
        }),
      );

    await tapAny.execute({ action: "longPress", duration: LONG_PRESS_HARD_MAX_MS });
    const swipe = adb
      .getCommandCalls()
      .find((call) => call.command.startsWith("shell input touchscreen swipe"));
    expect(swipe?.timeoutMs).toBe(LONG_PRESS_HARD_MAX_MS + 2000);
  });

  describe("validateOptions", () => {
    const EXACTLY_ONE = "container must specify exactly one";

    // A container must resolve to exactly one truthy selector. Zero truthy
    // selectors ({}, or both empty strings) is an error just like two — an empty
    // container cannot be located, so it must not pass validation and fall through
    // to an ambiguous match.
    test.each<[string, Record<string, unknown> | undefined, string | null]>([
      ["no container", undefined, null],
      ["elementId only", { elementId: "com.app:id/list" }, null],
      ["text only", { text: "My List" }, null],
      ["empty elementId but real text", { elementId: "", text: "List" }, null],
      ["real elementId but empty text", { elementId: "com.app:id/list", text: "" }, null],
      ["both elementId and text", { elementId: "com.app:id/list", text: "List" }, EXACTLY_ONE],
      ["empty container object", {}, EXACTLY_ONE],
      ["both selectors empty strings", { elementId: "", text: "" }, EXACTLY_ONE],
    ])("%s", (_name, container, expected) => {
      const tapAny = createTapAnyElement(new FakeElementSelector(makeElement()));
      const error = (tapAny as any).validateOptions({ action: "tap", container });
      if (expected === null) {
        expect(error).toBeNull();
      } else {
        expect(error).toContain(expected);
      }
    });
  });

  describe("findClickableElement", () => {
    test("delegates to selectClickable", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.element).not.toBeNull();
      expect(result.containerFound).toBe(true);
    });

    test("passes selectionStrategy to selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      (tapAny as any).findClickableElement(
        { action: "tap", selectionStrategy: "random" },
        { hierarchy: { node: {} } },
      );

      expect(selector.lastStrategy).toBe("random");
    });

    test("forwards scrollableContainer=true to the selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      (tapAny as any).findClickableElement(
        { action: "tap", scrollableContainer: true },
        { hierarchy: { node: {} } },
      );

      expect(selector.lastScrollableContainer).toBe(true);
    });

    test("leaves scrollableContainer unset when not requested", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      (tapAny as any).findClickableElement({ action: "tap" }, { hierarchy: { node: {} } });

      expect(selector.lastScrollableContainer).toBeUndefined();
    });

    test("returns null element when selector returns null", () => {
      const selector = new FakeElementSelector(null);
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.element).toBeNull();
    });

    test("filters out element whose center is off-screen", () => {
      const offScreenElement = {
        bounds: { left: -200, top: -200, right: -100, bottom: -100 },
        text: "Hidden",
        clickable: "true",
      } as any;
      const selector = new FakeElementSelector(offScreenElement);
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
        { observationScreenSize: { width: 1080, height: 1920 } },
      );

      expect(result.element).toBeNull();
    });

    test("keeps element whose center is on-screen", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
        { observationScreenSize: { width: 1080, height: 1920 } },
      );

      expect(result.element).not.toBeNull();
    });

    test("uses hierarchy dimensions over a different observation screen size", async () => {
      const element = {
        bounds: { left: 20, top: 20, right: 40, bottom: 40 },
        text: "Visible",
        clickable: "true",
      } as any;
      const adb = new FakeAdbClient();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const accessibilityDetector = new FakeAccessibilityDetector();
      accessibilityDetector.setTalkBackEnabled(false);
      const tapAny = new TapAnyElement(
        { name: "test-device", platform: "android", deviceId: "emulator-5554" },
        adb,
        {
          timer,
          elementSelector: new FakeElementSelector(element),
          accessibilityDetector,
          accessibilityService: {
            requestTapCoordinates: async () => ({
              success: false,
              totalTimeMs: 1,
              error: "Not connected",
            }),
            requestAction: async (action) => ({ success: true, action, totalTimeMs: 1 }),
            requestNodeAction: async (action) => ({ success: true, action, totalTimeMs: 1 }),
            supportsNodeActionSelectors: async () => true,
          },
        },
      );
      const viewHierarchy = { hierarchy: { node: {} }, screenWidth: 100, screenHeight: 100 };
      tapAny.observedInteraction = (action) =>
        action(recordObservationRead({ viewHierarchy, screenSize: { width: 10, height: 10 } }));
      tapAny.setRefreshViewHierarchyForTesting(async () => null);

      const result = await tapAny.execute({ action: "tap" });

      expect(result.success).toBe(true);
      expect(
        adb.getCommandCalls().some((call) => call.command.includes("input touchscreen tap")),
      ).toBe(true);
    });

    test("keeps element when screenSize is not provided", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.element).not.toBeNull();
    });
  });
});

describe("TapAnyElement Android gesture dispatch", () => {
  const hierarchy = { hierarchy: { node: { marker: "before" } } };

  function setup(
    result: A11yTapCoordinatesResult = { success: true, totalTimeMs: 1 },
    talkBackEnabled = false,
    element = makeElement(),
  ) {
    const observedHierarchy = { hierarchy: { node: { marker: "before" } } };
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(talkBackEnabled);
    const strategy = new FakeTalkBackTapStrategy();
    const calls: Array<{ x: number; y: number; duration: number | undefined }> = [];
    const adbTapCountAtRequest: number[] = [];
    const semanticCalls: string[] = [];
    const service = {
      requestTapCoordinates: async (x: number, y: number, duration?: number) => {
        adbTapCountAtRequest.push(
          adb.getCommandCalls().filter((call) => call.command.includes("input touchscreen tap"))
            .length,
        );
        calls.push({ x, y, duration });
        return { ...result, totalTimeMs: 1 };
      },
      requestAction: async (action: string) => {
        semanticCalls.push(action);
        return { success: true, action, totalTimeMs: 1 };
      },
      requestNodeAction: async (action: string, _selector: AccessibilityNodeSelector) => ({
        success: true,
        action,
        totalTimeMs: 1,
      }),
      supportsNodeActionSelectors: async () => true,
    };
    const tapAny = new TapAnyElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" },
      adb,
      {
        timer,
        elementSelector: new FakeElementSelector(element),
        accessibilityDetector: detector,
        accessibilityService: service,
        talkBackStrategy: strategy,
        talkBackDriverFactory: { createDriver: () => new FakeTalkBackNavigationDriver() },
      },
    );
    tapAny.observedInteraction = (action) =>
      action(
        recordObservationRead({
          viewHierarchy: observedHierarchy,
          screenSize: { width: 500, height: 500 },
        }),
      );
    let refreshCount = 0;
    tapAny.setRefreshViewHierarchyForTesting(async () => ({
      hierarchy: { node: { marker: `after-${++refreshCount}` } },
    }));
    return {
      tapAny,
      adb,
      timer,
      detector,
      strategy,
      calls,
      adbTapCountAtRequest,
      semanticCalls,
      observedHierarchy,
    };
  }

  test("unknown TalkBack retries once and marks a normal coordinate tap", async () => {
    const { tapAny, detector, calls, strategy } = setup();
    detector.setDefaultResult(null);
    const result = await tapAny.execute({ action: "tap" });
    expect(result.success).toBe(true);
    expect(detector.getDetectionCallCount()).toBe(2);
    expect(calls).toHaveLength(1);
    expect(strategy.directActivationCalls).toHaveLength(0);
    expect(result.warnings?.join(" ")).toContain("could not determine");
  });

  test("unconfirmed enabled TalkBack attaches a warning while fresh evidence does not", async () => {
    const { tapAny, detector } = setup({ success: true }, true);
    let unconfirmed = true;
    Object.assign(detector, {
      resolveTalkBackStateWithConfirmation: async () => ({ talkBack: true, unconfirmed }),
    });
    const stale = await tapAny.execute({ action: "tap" });
    expect(stale.success).toBe(true);
    expect(stale.warnings?.join(" ")).toContain("could not determine");
    unconfirmed = false;
    const fresh = await tapAny.execute({ action: "tap" });
    expect(fresh.success).toBe(true);
    expect(fresh.warnings?.join(" ") ?? "").not.toContain("could not determine");
  });

  test("tap uses CtrlProxy first and skips ADB when it succeeds", async () => {
    const { tapAny, adb, calls } = setup();
    const result = await tapAny.execute({ action: "tap" });
    expect(result.success).toBe(true);
    expect(calls).toEqual([{ x: 60, y: 45, duration: 10 }]);
    expect(
      adb
        .getCommandCalls()
        .filter((call) => call.command.includes("input") && call.command.includes("tap")),
    ).toEqual([]);
  });

  test("failed CtrlProxy tap falls back to touchscreen ADB input", async () => {
    const { tapAny, adb, calls, adbTapCountAtRequest } = setup({
      success: false,
      error: "unavailable",
      totalTimeMs: 1,
    });
    const result = await tapAny.execute({ action: "tap" });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(adbTapCountAtRequest).toEqual([0]);
    expect(adb.getCommandCalls().map((call) => call.command)).toContain(
      "shell input touchscreen tap 60 45",
    );
  });

  test("TalkBack activates the native element through accessibility action", async () => {
    const { tapAny, adb, strategy, calls } = setup({ success: true }, true);
    const result = await tapAny.execute({ action: "tap" });
    expect(result.success).toBe(true);
    expect(strategy.directActivationCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(result.warnings).toBeUndefined();
    expect(
      adb.getCommandCalls().some((call) => call.command.includes("input touchscreen tap")),
    ).toBe(false);
  });

  test("failed TalkBack activation uses a precise coordinate tap before ADB", async () => {
    const { tapAny, adb, strategy } = setup({ success: true }, true);
    strategy.setDirectActivationResult({
      success: false,
      method: "accessibility-action",
      error: "missing node",
    });
    const warning = "TalkBack activation is unconfirmed: coordinate gesture acknowledged";
    strategy.setPreciseTapResult({
      success: true,
      method: "coordinate-fallback",
      warnings: [warning],
    });
    const result = await tapAny.execute({ action: "tap" });
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([warning]);
    expect(strategy.directActivationCalls).toHaveLength(1);
    expect(strategy.preciseTapCalls).toHaveLength(1);
    expect(strategy.fallbackCalls).toHaveLength(0);
    expect(
      adb.getCommandCalls().some((call) => call.command.includes("input touchscreen tap")),
    ).toBe(false);
  });

  test("TalkBack double tap preserves coordinate fallback warnings", async () => {
    const { tapAny, strategy } = setup({ success: true }, true);
    const warning = "TalkBack activation is unconfirmed: double-tap gesture acknowledged";
    strategy.setFallbackResult({
      success: true,
      method: "coordinate-fallback",
      warnings: [warning],
    });
    const result = await tapAny.execute({ action: "doubleTap" });
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([warning]);
  });

  test("TalkBack retry preserves warnings without duplicates", async () => {
    const { tapAny, strategy } = setup({ success: true }, true);
    strategy.setDirectActivationResult({ success: false, method: "accessibility-action" });
    const warning = "TalkBack activation is unconfirmed: coordinate gesture acknowledged";
    strategy.setPreciseTapResult({
      success: true,
      method: "coordinate-fallback",
      warnings: [warning],
    });
    tapAny.setRefreshViewHierarchyForTesting(async () => hierarchy);
    const result = await tapAny.execute({ action: "tap" });
    expect(result.success).toBe(true);
    expect(strategy.preciseTapCalls).toHaveLength(2);
    expect(result.warnings).toEqual([warning]);
  });

  test("unchanged hierarchy retries exactly once", async () => {
    const { tapAny, calls } = setup();
    tapAny.setRefreshViewHierarchyForTesting(async () => hierarchy);
    const result = await tapAny.execute({ action: "tap" });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("unchanged hierarchy never retries a double tap or probes for a change", async () => {
    const { tapAny, calls } = setup();
    let probes = 0;
    tapAny.setRefreshViewHierarchyForTesting(async () => {
      probes++;
      return hierarchy;
    });
    const result = await tapAny.execute({ action: "doubleTap" });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(probes).toBe(0);
  });

  test("unchanged hierarchy never retries a long press or probes for a change", async () => {
    const { tapAny, adb } = setup();
    let probes = 0;
    tapAny.setRefreshViewHierarchyForTesting(async () => {
      probes++;
      return hierarchy;
    });
    const result = await tapAny.execute({ action: "longPress", duration: 1200 });
    expect(result.success).toBe(true);
    expect(adb.getCommandCalls().map((call) => call.command)).toEqual([
      "shell input touchscreen swipe 60 45 60 45 1200",
    ]);
    expect(probes).toBe(0);
  });

  test("rejects a changed capture before dispatching the selected target", async () => {
    const { tapAny, adb, calls, timer, observedHierarchy } = setup();
    tapAny.setBeforeAndroidTapForTesting(() => {
      const selected = getHierarchySnapshot(observedHierarchy);
      expect(selected).toBeDefined();
      const replacement = identifyObservedHierarchy(
        "android",
        { hierarchy: { node: { marker: "replacement" } } },
        "fresh",
        timer,
        undefined,
        "replacement-capture",
      );
      inheritHierarchySnapshot(replacement.hierarchy, selected?.hierarchy);
    });

    const result = await tapAny.execute({ action: "tap" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Selected hierarchy capture changed before tap dispatch");
    expect(calls).toEqual([]);
    expect(adb.getCommandCalls()).toEqual([]);
  });

  test("double tap uses two CtrlProxy presses separated by 200ms", async () => {
    const { tapAny, timer, calls } = setup();
    const sleeps: number[] = [];
    const originalSleep = timer.sleep.bind(timer);
    timer.sleep = async (ms) => {
      sleeps.push(ms);
      return originalSleep(ms);
    };
    const result = await tapAny.execute({ action: "doubleTap" });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(200);
  });

  test("long press tries the native accessibility action before ADB", async () => {
    const element = { ...makeElement(), "resource-id": "app:id/target" };
    const { tapAny, adb, semanticCalls } = setup({ success: true }, false, element);
    const result = await tapAny.execute({ action: "longPress", duration: 1200 });
    expect(result.success).toBe(true);
    expect(semanticCalls).toEqual(["long_click"]);
    expect(
      adb.getCommandCalls().some((call) => call.command.includes("input touchscreen swipe")),
    ).toBe(false);
  });
});

test.each([false, true])(
  "cached miss then fresh hit reports its coordinate capture (transient failure=%s)",
  async (failFirstCapture) => {
    const { DefaultHierarchyCapture, getHierarchySnapshot } =
      await import("../../../src/features/observe/HierarchyCapture");
    const { CountingIdGenerator } = await import("../../../src/utils/IdGenerator");
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbClient();
    const requests: string[] = [];
    const fresh = {
      // A capture from another display must not inherit the cached 100px screen.
      ...(failFirstCapture
        ? { displayId: 7 }
        : { displayId: 0, screenWidth: 500, screenHeight: 500 }),
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 500, bottom: 500 },
          node: {
            text: "Continue",
            clickable: true,
            "resource-id": "app:id/continue",
            bounds: { left: 200, top: 100, right: 300, bottom: 160 },
          },
        },
      },
    };
    const capture = new DefaultHierarchyCapture(
      "android",
      {
        readCached: async () => {
          throw new Error("fresh request required");
        },
        readFresh: async (request) => {
          requests.push(request.freshness);
          if (failFirstCapture && requests.length === 1) {
            throw new Error("temporary capture failure");
          }
          expect(request.timeoutMs).toBeGreaterThan(0);
          expect(request.timeoutMs).toBeLessThanOrEqual(400);
          return fresh;
        },
        projectVisible: (value) => value,
      },
      timer,
      new CountingIdGenerator(),
    );
    const tapAny = new TapAnyElement(
      { deviceId: "capture-tapany", name: "Test", platform: "android" },
      adb as any,
      {
        timer,
        hierarchyCapture: capture,
        accessibilityService: {
          requestTapCoordinates: async () => ({ success: false, totalTimeMs: 1 }),
          requestAction: async (action) => ({ success: true, action, totalTimeMs: 1 }),
          requestNodeAction: async (action) => ({ success: true, action, totalTimeMs: 1 }),
          supportsNodeActionSelectors: async () => true,
        },
      },
    );
    let searchFinished = false;
    tapAny.setRefreshViewHierarchyForTesting(async (refresh, ...args) =>
      searchFinished ? { hierarchy: { node: { marker: "after" } } } : refresh(...args),
    );
    const cached = {
      observationId: "old-capture",
      screenSize: { width: 100, height: 100 },
      viewHierarchy: { displayId: 0, hierarchy: { node: {} } },
    };
    tapAny.observedInteraction = (action) => action(cached);
    // The search capture completes before the gesture; only the post-tap probe changes.
    tapAny.setBeforeAndroidTapForTesting(() => {
      searchFinished = true;
    });
    const result = await tapAny.execute({ action: "tap", searchUntil: { duration: 500 } });
    expect(result).toMatchObject({ success: true });
    expect(requests).toEqual(failFirstCapture ? ["fresh", "fresh"] : ["fresh"]);
    expect(result.element["resource-id"]).toBe("app:id/continue");
    expect(result.element.bounds.left).toBe(200);
    expect(adb.getCommandCalls().map((call) => call.command)).toContain(
      "shell input touchscreen tap 250 130",
    );
    const snapshot = getHierarchySnapshot(fresh);
    expect(result.captureId).toBeDefined();
    expect(result.captureId).not.toBe("old-capture");
    expect(result.captureId).toBe(snapshot?.captureId);
  },
);

describe("TapAnyElement node long press fallbacks", () => {
  function setup(advertised = true) {
    const element: Element = {
      ...makeElement(),
      "test-tag": "widget_42",
      actions: advertised ? ["long_click"] : [],
    };
    const proxy = new FakeCtrlProxy();
    const adb = new FakeAdbClient();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tapAny = new TapAnyElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" },
      adb,
      {
        timer,
        elementSelector: new FakeElementSelector(element),
        accessibilityService: proxy,
        accessibilityDetector: new FakeAccessibilityDetector(),
      },
    );
    tapAny.observedInteraction = (action) =>
      action(
        recordObservationRead({
          viewHierarchy: { hierarchy: { node: {} } },
          screenSize: { width: 500, height: 500 },
        }),
      );
    tapAny.setRefreshViewHierarchyForTesting(async () => null);
    return { proxy, adb, tapAny };
  }

  test("uses coordinates without attempting a node action when selector support is unavailable", async () => {
    const { proxy, adb, tapAny } = setup();
    proxy.setSupportsNodeActionSelectors(false);
    expect((await tapAny.execute({ action: "longPress", duration: 1200 })).success).toBe(true);
    expect(proxy.getNodeActionHistory()).toEqual([]);
    expect(adb.getAllCommands()).toEqual(["shell input touchscreen swipe 60 45 60 45 1200"]);
  });

  test("rejected touchscreen long press falls back to generic input swipe", async () => {
    const { proxy, adb, tapAny } = setup();
    proxy.setSupportsNodeActionSelectors(false);
    adb.setCommandResult(
      "shell input touchscreen swipe 60 45 60 45 1200",
      "Unknown command: touchscreen",
    );

    const result = await tapAny.execute({ action: "longPress", duration: 1200 });

    expect(result.success).toBe(true);
    expect(adb.getAllCommands()).toEqual([
      "shell input touchscreen swipe 60 45 60 45 1200",
      "shell input swipe 60 45 60 45 1200",
    ]);
  });

  test("rejected touchscreen and fallback long presses report failure", async () => {
    const { proxy, adb, tapAny } = setup();
    proxy.setSupportsNodeActionSelectors(false);
    adb.setCommandResult(
      "shell input touchscreen swipe 60 45 60 45 1200",
      "Unknown command: touchscreen",
    );
    adb.setCommandResult(
      "shell input swipe 60 45 60 45 1200",
      "",
      "Usage: input [<source>] [-d DISPLAY_ID] <command>",
    );

    const result = await tapAny.execute({ action: "longPress", duration: 1200 });

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Android command failed: shell input swipe 60 45 60 45 1200: Usage: input [<source>] [-d DISPLAY_ID] <command>",
    );
    expect(adb.getAllCommands()).toEqual([
      "shell input touchscreen swipe 60 45 60 45 1200",
      "shell input swipe 60 45 60 45 1200",
    ]);
  });

  test("reports failed advertised long_click without coordinate fallback", async () => {
    const { proxy, adb, tapAny } = setup();
    proxy.setActionResult({
      success: false,
      action: "long_click",
      totalTimeMs: 1,
      error: "rejected",
    });
    const result = await tapAny.execute({ action: "longPress" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Semantic long press failed for the selected element: rejected");
    expect(proxy.getNodeActionHistory()).toHaveLength(1);
    expect(adb.getAllCommands()).toEqual([]);
  });

  test("falls back to coordinates when an advertised long_click reports node not found", async () => {
    const { proxy, adb, tapAny } = setup();
    proxy.setActionResult({
      success: false,
      action: "long_click",
      totalTimeMs: 1,
      error: "Element not found with NodeSelector(testTag=message_row_42)",
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await tapAny.execute({ action: "longPress", duration: 1200 });
      expect(result.success).toBe(true);
      expect(proxy.getNodeActionHistory()).toHaveLength(1);
      expect(adb.getAllCommands()).toEqual(["shell input touchscreen swipe 60 45 60 45 1200"]);
    } finally {
      warning.mockRestore();
    }
  });

  test.each([false, true])(
    "logs a thrown node action and falls back (advertised=%s)",
    async (advertised) => {
      const { proxy, adb, tapAny } = setup(advertised);
      proxy.setFailureMode("requestNodeAction", new Error("runner disconnected"));
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect((await tapAny.execute({ action: "longPress", duration: 1200 })).success).toBe(true);
        expect(warning).toHaveBeenCalledWith(
          "[TapAnyElement] Accessibility long click error: Error: runner disconnected",
        );
        expect(adb.getAllCommands()).toEqual(["shell input touchscreen swipe 60 45 60 45 1200"]);
      } finally {
        warning.mockRestore();
      }
    },
  );
});

describe("tapAny long press safety", () => {
  function setup() {
    const adb = new FakeAdbClient();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const element: Element = {
      text: "ListItem",
      clickable: true,
      "hierarchy-source": "uiautomator",
      bounds: { left: 10, top: 20, right: 110, bottom: 70 },
    };
    const displayLookup = mock(() => undefined);
    const action = new TapAnyElement(
      { name: "test-device", platform: "android", deviceId: "tap-any-long-press-bound" },
      adb as unknown as AdbClient,
      {
        timer,
        elementSelector: new FakeElementSelector(element),
        accessibilityDetector: new FakeAccessibilityDetector(),
        lastRenderedObservation: displayLookup,
      },
    );
    action.observedInteraction = (callback) =>
      callback(
        recordObservationRead({
          viewHierarchy: { hierarchy: { node: element } },
          screenSize: { width: 500, height: 500 },
        }),
      );
    action.setRefreshViewHierarchyForTesting(async () => null);
    return { adb, timer, action, displayLookup };
  }

  test.each([61000, 60000.5, Infinity])(
    "rejects duration %s before any adb command",
    async (duration) => {
      const h = setup();
      const observe = spyOn(h.action, "observedInteraction");
      const result = await h.action.execute({ action: "longPress", duration, display: "1" });
      expect(result.success).toBe(false);
      expect(result.action).toBe("longPress");
      expect(result.element.bounds).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
      expect(result.error).toContain(`maximum is 60000 ms; requested ${duration} ms`);
      expect(observe).not.toHaveBeenCalled();
      expect(h.displayLookup).not.toHaveBeenCalled();
      expect(h.adb.getAllCommands()).toEqual([]);
    },
  );

  test.each([
    [17000, 120000],
    [30000, undefined],
    [20000, 22000],
    [200, 120000],
    [undefined, undefined],
    [undefined, 120000],
    [60000, 120000],
  ])("budget admission accepts duration %s with remaining %s", async (duration, remaining) => {
    const h = setup();
    const result = await h.action.execute({ action: "longPress", duration }, undefined, undefined, {
      requestDeadlineMs: remaining === undefined ? undefined : h.timer.now() + remaining,
    });
    expect(result.success).toBe(true);
    expect(h.adb.getCommandCalls()).toEqual([
      expect.objectContaining({
        command: `shell input touchscreen swipe 60 45 60 45 ${duration ?? 1000}`,
        timeoutMs: Math.max(5000, (duration ?? 1000) + 2000),
      }),
    ]);
  });

  test.each([5000, 21999])(
    "budget admission rejects before display/observation with %s ms",
    async (remaining) => {
      const h = setup();
      const observe = spyOn(h.action, "observedInteraction");
      const result = await h.action.execute(
        { action: "longPress", duration: 20000, display: "1" },
        undefined,
        undefined,
        { requestDeadlineMs: h.timer.now() + remaining },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        `Failed to tap clickable element: longPress duration 20000 ms does not fit the remaining request budget (${remaining} ms; needs 22000 ms including dispatch headroom); the press was not started.`,
      );
      expect(observe).not.toHaveBeenCalled();
      expect(h.displayLookup).not.toHaveBeenCalled();
      expect(h.adb.getAllCommands()).toEqual([]);
    },
  );

  test.each(["touchscreen", "fallback", "timeout"])(
    "%s hold failure reports the risk without retrying cancellation",
    async (path) => {
      const h = setup();
      const controller = new AbortController();
      const executeCommand = h.adb.executeCommand.bind(h.adb);
      const dispatch = spyOn(h.adb, "executeCommand").mockImplementation(async (...args) => {
        await executeCommand(...args);
        if (path === "fallback" && args[0].includes("touchscreen")) {
          throw new Error("touchscreen source unavailable");
        }
        if (path === "timeout") {
          throw new AdbCommandTimeoutError("Command timed out");
        }
        expect(args[4]).toBe(controller.signal);
        controller.abort();
        throw new DOMException("Operation aborted", "AbortError");
      });
      try {
        const result = await h.action.execute(
          { action: "longPress", duration: 1500 },
          undefined,
          controller.signal,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("press may still be held on the device for up to 1500 ms");
        expect(h.adb.getAllCommands()).toEqual(
          path === "fallback"
            ? [
                "shell input touchscreen swipe 60 45 60 45 1500",
                "shell input swipe 60 45 60 45 1500",
              ]
            : ["shell input touchscreen swipe 60 45 60 45 1500"],
        );
      } finally {
        dispatch.mockRestore();
      }
    },
  );
});
