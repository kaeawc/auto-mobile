import { describe, expect, spyOn, test } from "bun:test";
import androidHome from "../../fixtures/observe/android-home.json";
import type { BootedDevice, Element, ObserveResult } from "../../../src/models";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { TalkBackSwipeExecutor } from "../../../src/features/action/swipeon/TalkBackSwipeExecutor";
import { ScrollUntilVisible } from "../../../src/features/action/swipeon/ScrollUntilVisible";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { throwIfAborted } from "../../../src/utils/toolUtils";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeGestureExecutor } from "../../fakes/FakeGestureExecutor";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeElementFinder } from "../../fakes/FakeElementFinder";
import { FakeScrollElementResolver } from "../../fakes/FakeScrollElementResolver";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeScrollAccessibilityService } from "../../fakes/FakeScrollAccessibilityService";
import { FakeTalkBackSwipeExecutor } from "../../fakes/FakeTalkBackSwipeExecutor";
import { FakeOverlayDetector } from "../../fakes/FakeOverlayDetector";
import { FakeElementGeometry } from "../../fakes/FakeElementGeometry";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";

const observation = androidHome as unknown as ObserveResult;
const hierarchy = observation.viewHierarchy!;
const device: BootedDevice = { deviceId: "sequence-device", name: "Test", platform: "android" };
const element: Element = {
  text: "Selected",
  "resource-id": "selected",
  bounds: { left: 100, top: 100, right: 200, bottom: 200 },
};

function clock(calls: string[]): FakeTimer {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const sleep = timer.sleep.bind(timer);
  timer.sleep = (ms) => {
    calls.push(`sleep:${ms}`);
    return sleep(ms);
  };
  return timer;
}

describe("gesture request sequences", () => {
  test.each(["success", "refusal", "dispatched", "throws", "absent", "abort"])(
    "TalkBack accessibility scroll: %s",
    async (mode) => {
      const calls: string[] = [];
      const timer = clock(calls);
      const proxy = new FakeCtrlProxy(timer);
      const controller = new AbortController();
      proxy.getAccessibilityHierarchy = async () => {
        calls.push("hierarchy");
        return { hierarchy: { node: { $: element } } };
      };
      proxy.requestAction = async (action, id, timeout) => {
        calls.push(`action:${action}:${id}:${timeout}`);
        if (mode === "throws") {
          throw new Error("transport lost");
        }
        expect(calls).toEqual(
          mode === "absent"
            ? ["fence", "two:100:500:100:200:400:100:5000"]
            : ["hierarchy", "action:scroll_forward:selected:5000"],
        );
        if (mode === "abort") {
          controller.abort();
        }
        return {
          success: mode === "success",
          action,
          totalTimeMs: 1,
          dispatched: mode === "dispatched",
          acknowledged: false,
          error: "refused",
        };
      };
      proxy.requestTwoFingerSwipe = async (x1, y1, x2, y2, duration, offset, timeout) => {
        calls.push(`two:${x1}:${y1}:${x2}:${y2}:${duration}:${offset}:${timeout}`);
        return { success: true, totalTimeMs: 1 };
      };
      const executor = new TalkBackSwipeExecutor(
        device,
        new FakeGestureExecutor(),
        proxy as unknown as AndroidCtrlProxyClient,
        new FakeAccessibilityDetector(),
        new FakeAdbClient(),
        timer,
      );
      const run = executor.executeAndroidSwipeWithAccessibility(
        100,
        500,
        100,
        200,
        "up",
        mode === "absent" ? null : element,
        {
          duration: 400,
          displayFence: {
            assertCurrent: () => {
              calls.push("fence");
            },
          },
        },
        new NoOpPerformanceTracker(),
        controller.signal,
      );
      if (mode === "abort") {
        await expect(run).rejects.toThrow("Operation cancelled");
      } else {
        const result = await run;
        expect(result.success).toBe(mode !== "dispatched" && mode !== "throws");
        if (mode === "dispatched" || mode === "throws") {
          expect(result.error).toContain("indeterminate");
        }
      }
      const action = "action:scroll_forward:selected:5000";
      const fallback = ["fence", "two:100:500:100:200:400:100:5000"];
      expect(calls).toEqual(
        mode === "absent"
          ? fallback
          : mode === "refusal"
            ? ["hierarchy", action, ...fallback]
            : ["hierarchy", action],
      );
    },
  );

  test.each(["android", "ios"] as const)("drag interaction sequence on %s", async (platform) => {
    const calls: string[] = [];
    const timer = clock(calls);
    const proxy = new FakeCtrlProxy(timer);
    const client = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      proxy as unknown as AndroidCtrlProxyClient,
    );
    const available = spyOn(AndroidCtrlProxyManager.prototype, "isAvailable").mockImplementation(
      async () => {
        calls.push("availability");
        return true;
      },
    );
    try {
      const drag = new DragAndDrop({ ...device, platform }, new FakeAdbClient(), timer, {
        visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      });
      drag.observedInteraction = async (action) => {
        calls.push("observe-before");
        const result = await action(observation, {
          assertCurrent: () => {
            calls.push("fence");
          },
        });
        calls.push("observe-after");
        return result;
      };
      drag["resolveViewHierarchy"] = async () => {
        calls.push("hierarchy");
        return hierarchy;
      };
      drag["resolveTargetPoints"] = () => {
        calls.push("resolve");
        return { sourcePoint: { x: 10, y: 20 }, targetPoint: { x: 30, y: 40 } };
      };
      drag["executeDrag"] = async (...args) => {
        calls.push(`drag:${args.slice(0, 7).join(":")}`);
        return { success: true, a11yTotalTimeMs: 1200 };
      };
      const result = await drag.execute({ source: { text: "Source" }, target: { text: "Target" } });
      expect(result).toMatchObject({ success: true, duration: 300, a11yTotalTimeMs: 1200 });
      expect(calls).toEqual([
        ...(platform === "android" ? ["availability"] : []),
        "observe-before",
        "hierarchy",
        "resolve",
        "fence",
        "drag:10:20:30:40:600:300:100",
        "sleep:100",
        "observe-after",
      ]);
    } finally {
      client.mockRestore();
      available.mockRestore();
    }
  });

  test.each(["immediate", "poll", "null", "late", "expired", "abort"])(
    "tapAny bounded selection sequence: %s",
    async (mode) => {
      const calls: string[] = [];
      const timer = clock(calls);
      const selector = new FakeElementSelector(mode === "immediate" ? element : null);
      const select = selector.selectClickable.bind(selector);
      selector.selectClickable = (...args) => {
        calls.push("select");
        return select(...args);
      };
      const tap = new TapAnyElement(device, new FakeAdbClient(), {
        timer,
        elementSelector: selector,
      });
      const controller = new AbortController();
      tap.observedInteraction = async (action) => {
        calls.push("observe");
        return action(observation);
      };
      let refreshCount = 0;
      tap.setRefreshViewHierarchyForTesting(async (_refresh, timeout, screen, signal) => {
        expect(screen).toBe(observation.screenSize);
        expect(signal).toBe(controller.signal);
        calls.push(`refresh:${timeout}`);
        refreshCount++;
        if (mode === "null" && refreshCount === 1) {
          return null;
        }
        if (mode === "late") {
          timer.advanceTime(timeout);
        }
        if (mode === "abort") {
          controller.abort();
        }
        selector.setNextElement(element);
        return hierarchy;
      });
      tap["executeAndroidTap"] = async (_action, x, y, duration, _target, _signal, context) => {
        calls.push(`tap:${x}:${y}:${duration}`);
        throwIfAborted(_signal);
        context?.onActivationWarnings?.(["activation warning"]);
      };
      tap["retryAndroidTapIfNoChange"] = async () => {
        calls.push("retry-check");
      };
      const run = tap.execute(
        { action: "tap", searchUntil: { duration: mode === "expired" ? 100 : 500 } },
        undefined,
        controller.signal,
      );
      if (mode === "immediate") {
        expect(calls).toEqual(["observe", "select", "tap:150:150:0"]);
      }
      const result = await run;
      const successful = mode === "immediate" || mode === "poll" || mode === "null";
      expect(result.success).toBe(successful);
      if (successful) {
        expect(result.warnings).toEqual(["activation warning"]);
      }
      const initial = ["observe", "select"];
      const dispatch = ["tap:150:150:0", "retry-check"];
      const expected: Record<string, string[]> = {
        immediate: [...initial, ...dispatch],
        poll: [...initial, "sleep:100", "refresh:400", "select", ...dispatch],
        null: [
          ...initial,
          "sleep:100",
          "refresh:400",
          "sleep:100",
          "refresh:300",
          "select",
          ...dispatch,
        ],
        late: [...initial, "sleep:100", "refresh:400"],
        expired: [...initial, "sleep:100"],
        abort: [...initial, "sleep:100", "refresh:400", "select", "tap:150:150:0"],
      };
      expect(calls).toEqual(expected[mode]);
    },
  );

  test.each([
    [undefined, true, "No clickable element found"],
    [{ text: "Absent" }, false, "Container element not found with provided text 'Absent'"],
    [
      { elementId: "selected" },
      true,
      "No clickable element found within container elementId 'selected'",
    ],
  ] as const)(
    "tapAny missing target diagnostics: %j",
    async (container, containerFound, message) => {
      const calls: string[] = [];
      const timer = clock(calls);
      const selector = new FakeElementSelector();
      const select = selector.selectClickable.bind(selector);
      selector.selectClickable = (...args) => {
        calls.push("select");
        return select(...args);
      };
      const tap = new TapAnyElement(device, new FakeAdbClient(), {
        timer,
        elementSelector: selector,
      });
      tap["isContainerAvailable"] = () => {
        calls.push("container");
        return containerFound;
      };
      tap.observedInteraction = async (action) => {
        calls.push("observe");
        return action(observation);
      };
      const result = await tap.execute({
        action: "tap",
        container,
        searchUntil: { duration: 100 },
      });
      expect(result).toMatchObject({
        success: false,
        error: `Failed to tap clickable element: ${message}`,
      });
      expect(calls).toEqual(["observe", "container", "select", "sleep:100"]);
    },
  );

  test("tapAny skips selection when the observation has no hierarchy", async () => {
    const calls: string[] = [];
    const tap = new TapAnyElement(device, new FakeAdbClient(), { timer: clock(calls) });
    tap.observedInteraction = async (action) => {
      calls.push("observe");
      return action({ ...observation, viewHierarchy: undefined });
    };
    tap["findClickableElement"] = () => {
      calls.push("select");
      return { element, containerFound: true };
    };
    expect(await tap.execute({ action: "tap" })).toMatchObject({
      success: false,
      error: "Unable to get view hierarchy, cannot tap on element",
    });
    expect(calls).toEqual(["observe"]);
  });

  test.each([
    ["android", true, true, "android"],
    ["ios", true, true, "ios"],
    ["ios", true, false, "none"],
    ["ios", false, true, "none"],
  ] as const)("response projection %s raw=%s screen=%s", (platform, raw, screen, expected) => {
    const calls: string[] = [];
    const tap = new TapAnyElement({ ...device, platform }, new FakeAdbClient(), {
      timer: clock(calls),
    });
    const rawMode = spyOn(serverConfig, "isRawElementSearchEnabled").mockReturnValue(raw);
    const android = spyOn(tap["viewHierarchy"], "filterViewHierarchy").mockImplementation(
      (value) => {
        calls.push("android");
        return value;
      },
    );
    const ios = spyOn(tap["viewHierarchy"], "filterOffscreenNodes").mockImplementation(
      (value, width, height) => {
        calls.push("ios");
        expect([width, height]).toEqual([1080, 2400]);
        return value;
      },
    );
    try {
      expect(
        tap["prepareViewHierarchyForResponse"](
          hierarchy,
          screen ? observation.screenSize : undefined,
        ),
      ).toBe(hierarchy);
      expect(calls).toEqual(expected === "none" ? [] : [expected]);
    } finally {
      rawMode.mockRestore();
      android.mockRestore();
      ios.mockRestore();
    }
  });

  test.each([
    ["android", "found"],
    ["ios", "found"],
    ["android", "missing"],
    ["ios", "missing"],
    ["android", "abort"],
    ["ios", "abort"],
  ] as const)("scroll container retry refresh on %s: %s", async (platform, mode) => {
    const calls: string[] = [];
    const timer = clock(calls);
    const controller = new AbortController();
    const sleep = timer.sleep.bind(timer);
    timer.sleep = async (ms) => {
      await sleep(ms);
      if (mode === "abort") {
        controller.abort();
      }
    };
    const finder = new FakeElementFinder();
    const find = finder.findElementByText.bind(finder);
    finder.findElementByText = (...args) => {
      calls.push("find");
      return find(...args);
    };
    const observe = new FakeObserveScreen();
    observe.execute = async (options) => {
      expect(options).toMatchObject({
        freshness: "cached-ok",
        skipScreenshot: true,
        skipAccessibilityAudit: true,
      });
      calls.push("observe");
      finder.nextElementByText = element;
      return mode === "missing" ? { ...observation, viewHierarchy: undefined } : observation;
    };
    const proxy = new FakeScrollAccessibilityService();
    const service = {
      requestAction: proxy.requestAction.bind(proxy),
      getAccessibilityHierarchy: async (...args: unknown[]) => {
        expect(args.slice(0, 4)).toEqual([
          { query: "Selected", containerElementId: undefined },
          undefined,
          undefined,
          undefined,
        ]);
        calls.push("hierarchy");
        finder.nextElementByText = element;
        return mode === "missing" ? null : hierarchy;
      },
    };
    const talkBack = new FakeTalkBackSwipeExecutor();
    const scroll = new ScrollUntilVisible({
      device: { ...device, platform },
      timer,
      resolver: new FakeScrollElementResolver(finder),
      geometry: new FakeElementGeometry(),
      observeScreen: observe,
      accessibilityService: service,
      accessibilityDetector: new FakeAccessibilityDetector(),
      adb: new FakeAdbClient(),
      overlayDetector: new FakeOverlayDetector(),
      talkBackExecutor: talkBack,
      voiceOverExecutor: talkBack,
      getDuration: () => 300,
      resolveBoomerangConfig: () => undefined,
      buildPredictionArgs: () => ({}),
      observedInteraction: async (action) => action(observation),
    });
    const run = scroll.findTargetElement(
      { container: { text: "Selected" } },
      hierarchy,
      0,
      controller.signal,
    );
    if (mode === "found") {
      expect(await run).toEqual(element);
    } else {
      await expect(run).rejects.toThrow(
        mode === "abort" ? "Operation cancelled" : "Element not found",
      );
    }
    expect(calls).toEqual(
      mode === "abort"
        ? ["find", "sleep:10"]
        : [
            "find",
            "sleep:10",
            platform === "android" ? "hierarchy" : "observe",
            ...(mode === "found" ? ["find"] : []),
          ],
    );
  });
});
