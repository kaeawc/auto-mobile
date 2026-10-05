import { frame, harness as displayHarness } from "./displaySwipeHarness";
import { runWithAbortSignal } from "../../../../src/utils/AbortContext";
import { DEFAULT_HIERARCHY_READ_TIMEOUT_MS } from "../../../../src/features/observe/DeviceHierarchyCapture";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { AdbClient } from "../../../../src/utils/android-cmdline-tools/AdbClient";
import type { ObserveResult } from "../../../../src/models";
import { encodeAndroidFlat, encodeIosDollar } from "../../../fixtures/hierarchyArbitraries";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeAwaitIdle } from "../../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";

const oldBounds = { left: 0, top: 0, right: 400, bottom: 500 };
const liveBounds = { left: 500, top: 700, right: 1000, bottom: 1800 };
function screen(
  id: string,
  visible: boolean,
  after = false,
  platform: "android" | "ios" = "android",
): ObserveResult {
  const bounds = id === "list" ? oldBounds : liveBounds;
  return {
    timestamp: 0,
    freshness: { isFresh: true },
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    viewHierarchy: {
      hierarchy: {
        node: (platform === "ios" ? encodeIosDollar : encodeAndroidFlat)({
          attrs: {
            class: platform === "ios" ? "XCUIElementTypeApplication" : "android.widget.FrameLayout",
          },
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          children: [
            {
              attrs: {
                "resource-id": id,
                scrollable: true,
                class:
                  platform === "ios" ? "XCUIElementTypeScrollView" : "android.widget.ScrollView",
              },
              bounds,
              children: [
                {
                  attrs: { text: visible ? "Item 42" : after ? "after" : "before" },
                  bounds: { ...bounds, bottom: bounds.top + 100 },
                  children: [],
                },
              ],
            },
          ],
        }),
      },
    },
  };
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
  mock.restore();
});

function harness({
  visible = false,
  sameList = false,
  cachedVisible = true,
  platform = "android",
  freshReadFailure = false,
  readDuringLookup = false,
  initialReadIsFresh = false,
}: {
  visible?: boolean;
  sameList?: boolean;
  cachedVisible?: boolean;
  platform?: "android" | "ios";
  freshReadFailure?: boolean;
  readDuringLookup?: boolean;
  initialReadIsFresh?: boolean;
} = {}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const ctrl = new FakeCtrlProxy(timer);
  const client = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    ctrl as unknown as AndroidCtrlProxyClient,
  );
  restores.push(() => client.mockRestore());
  const gesture = new FakeGestureExecutor();
  const observe = new FakeObserveScreen();
  const voiceover = new FakeTalkBackSwipeExecutor();
  const dispatched = () => gesture.getSwipeCalls().length + voiceover.getCallCount();
  let cached = screen("list", cachedVisible, false, platform);
  observe.setObserveResult(() =>
    screen(sameList ? "list" : "live-list", visible || dispatched() > 0, true, platform),
  );
  let lookupRead = false;
  spyOn(observe, "getMostRecentCachedObserveResult").mockImplementation(async () => {
    if (readDuringLookup && !lookupRead) {
      lookupRead = true;
      await observe.execute({ freshness: "fresh" });
    }
    return cached;
  });
  // Model the real observer: cached-ok hits do not record a device read.
  const execute = observe.execute.bind(observe);
  spyOn(observe, "execute").mockImplementation(async (options) => {
    if (
      !initialReadIsFresh &&
      options?.freshness === "cached-ok" &&
      options.minTimestamp === undefined
    ) {
      return cached;
    }
    if (freshReadFailure && dispatched() === 0) {
      observe.setFailureMode("execute", new Error("runner unavailable"));
    }
    try {
      cached = await execute(options);
      return cached;
    } finally {
      observe.setFailureMode("execute", null);
    }
  });
  const cache = observe.cacheObserveResult.bind(observe);
  spyOn(observe, "cacheObserveResult").mockImplementation(async (result, generation, cachedAt) => {
    cached = result;
    await cache(result, generation, cachedAt);
  });
  const action = new SwipeOn(
    { name: "fake", platform, deviceId: "cached-resolution-swipe" },
    new FakeAdbClient() as unknown as AdbClient,
    {
      timer,
      observeScreen: observe,
      executeGesture: gesture,
      voiceOverExecutor: voiceover,
      accessibilityDetector: new FakeAccessibilityDetector(),
    },
  );
  action.awaitIdle = new FakeAwaitIdle();
  action.window = new FakeWindow();
  return { action, observe, gesture, timer, ctrl, voiceover };
}

test("cached lookFor hit is discarded and the live screen is searched", async () => {
  const h = harness();
  const result = await h.action.execute({ direction: "up", lookFor: { text: "Item 42" } });
  console.info("lookFor scrolling device reads:", h.observe.getExecuteCallCount());
  expect(result.success).toBe(true);
  expect(result.found).toBe(true);
  expect(result.scrollIterations).toBe(1);
  expect(result.element?.bounds.left).toBe(liveBounds.left);
  expect(h.observe.getExecuteCallCount()).toBe(2);
  expect(h.ctrl.getHierarchyRequestCount()).toBe(0);
});

test("cached auto-target bounds are replaced by the live scrollable bounds", async () => {
  const h = harness();
  const result = await h.action.execute({ direction: "up" });
  console.info("direction device reads:", h.observe.getExecuteCallCount());
  expect(result.success).toBe(true);
  expect(result.element?.bounds).toEqual(liveBounds);
  const call = h.gesture.getSwipeCalls()[0];
  expect(call.x1).toBeGreaterThanOrEqual(liveBounds.left);
  expect(call.x2).toBeLessThanOrEqual(liveBounds.right);
  expect(call.y1).toBeGreaterThanOrEqual(liveBounds.top);
  expect(call.y2).toBeLessThanOrEqual(liveBounds.bottom);
  expect(h.observe.getExecuteCallCount()).toBe(2);
  expect(h.ctrl.getHierarchyRequestCount()).toBe(0);
});

test("a cached container that disappeared fails before dispatch", async () => {
  const h = harness();
  const result = await h.action.execute({ direction: "up", container: { elementId: "list" } });
  console.info("missing container device reads:", h.observe.getExecuteCallCount());
  expect(result.success).toBe(false);
  expect(result.error).toContain("not found");
  expect(h.gesture.getSwipeCalls()).toHaveLength(0);
  expect(h.observe.getExecuteCallCount()).toBe(1);
  expect(h.ctrl.getHierarchyRequestCount()).toBe(1); // existing empty selector-retry capture
});

test("lookFor already visible on the live screen takes exactly one device read", async () => {
  const h = harness({ visible: true });
  const result = await h.action.execute({ direction: "up", lookFor: { text: "Item 42" } });
  console.info("visible lookFor device reads:", h.observe.getExecuteCallCount());
  expect(result).toMatchObject({ success: true, found: true, scrollIterations: 0 });
  expect(result.element?.bounds.left).toBe(liveBounds.left);
  expect(h.observe.getExecuteCallCount()).toBe(1);
  expect(h.ctrl.getHierarchyRequestCount()).toBe(0);
});

test("each successive swipe refreshes the cache left by the preceding call", async () => {
  const h = harness({ sameList: true });
  await h.action.execute({ direction: "up" });
  const first = h.observe.getExecuteCallCount();
  await h.action.execute({ direction: "up" });
  console.info("successive swipe device reads:", first, h.observe.getExecuteCallCount() - first);
  expect(first).toBe(2);
  expect(h.observe.getExecuteCallCount() - first).toBe(2);
  expect(h.ctrl.getHierarchyRequestCount()).toBe(0);
});

test("a still-present explicit container takes one resolution and one post-action read", async () => {
  const h = harness({ sameList: true });
  expect(
    (await h.action.execute({ direction: "up", container: { elementId: "list" } })).success,
  ).toBe(true);
  console.info("container device reads:", h.observe.getExecuteCallCount());
  expect(h.observe.getExecuteCallCount()).toBe(2);
  expect(h.ctrl.getHierarchyRequestCount()).toBe(0);
});

test("lookFor that needs a scroll adds only the initial resolution read", async () => {
  const h = harness({ cachedVisible: false, sameList: true });
  const result = await h.action.execute({ direction: "up", lookFor: { text: "Item 42" } });
  console.info("initially missing lookFor device reads:", h.observe.getExecuteCallCount());
  expect(result).toMatchObject({ success: true, found: true, scrollIterations: 1 });
  expect(h.observe.getExecuteCallCount()).toBe(2);
  expect(h.ctrl.getHierarchyRequestCount()).toBe(0);
});

test("an auto-target hierarchy acquired earlier in this call is not read twice", async () => {
  const h = harness({ readDuringLookup: true });
  const result = await h.action.execute({ direction: "up" });
  expect(result.element?.bounds).toEqual(liveBounds);
  expect(h.observe.getExecuteCallCount()).toBe(2); // acquisition, post-action
  expect(
    h.observe.getExecuteOptions().filter((options) => options.minTimestamp === undefined),
  ).toHaveLength(1);
});

test("lookFor's initial device read and scroll iteration do not gain another read", async () => {
  const h = harness({ initialReadIsFresh: true });
  // Keep idle polling outside this short search budget to count captures exactly.
  const result = await h.action.execute({
    direction: "up",
    lookFor: { text: "Item 42", maxTime: 300 },
  });
  expect(result).toMatchObject({ success: true, found: true, scrollIterations: 1 });
  expect(h.observe.getExecuteCallCount()).toBe(2); // initial, post-action
});

test("a failed proactive read retains the screen-swipe fallback", async () => {
  const h = harness({ freshReadFailure: true });
  const result = await h.action.execute({ direction: "up" });
  expect(result).toMatchObject({ success: true, targetType: "screen" });
  expect(h.gesture.getSwipeCalls()).toHaveLength(1);
  expect(h.observe.getExecuteCallCount()).toBe(2); // failed refresh, post-action
});

for (const options of [
  { direction: "up" as const, container: { elementId: "list" } },
  { direction: "up" as const, lookFor: { text: "Item 42" } },
]) {
  test(`failed fresh read cannot authorize a cached ${options.container ? "container" : "lookFor hit"}`, async () => {
    const h = harness({ freshReadFailure: true });
    const result = await h.action.execute(options);
    expect(result.success).toBe(false);
    expect(result.found).not.toBe(true);
    expect(h.gesture.getSwipeCalls()).toHaveLength(0);
    expect(h.observe.getExecuteCallCount()).toBe(1);
  });
}

test("screen-only swipes gain no pre-resolution device read", async () => {
  const h = harness();
  expect((await h.action.execute({ direction: "up", autoTarget: false })).success).toBe(true);
  expect(h.observe.getExecuteCallCount()).toBe(1); // existing post-action capture only
  expect(h.observe.getExecuteOptions()[0].minTimestamp).toBeDefined();
});

for (const remaining of [0, 75, DEFAULT_HIERARCHY_READ_TIMEOUT_MS + 100]) {
  test(`proactive hierarchy read is capped by the ${remaining}ms remaining request budget`, async () => {
    const h = harness();
    const result = await runWithAbortSignal(
      undefined,
      () => h.action.execute({ direction: "up" }),
      {
        getDeadlineMs: () => remaining,
        textState: { dispatched: () => () => {} },
      },
    );
    expect(result.success).toBe(true);
    const preReads = h.observe
      .getExecuteOptions()
      .filter((options) => options.minTimestamp === undefined);
    expect(preReads).toHaveLength(remaining === 0 ? 0 : 1);
    if (remaining > 0) {
      expect(preReads[0].timeoutMs).toBe(Math.min(remaining, DEFAULT_HIERARCHY_READ_TIMEOUT_MS));
    } else {
      expect(result.targetType).toBe("screen");
    }
  });
}

for (const mode of ["direction", "container", "lookFor"] as const) {
  test(`iOS ${mode} also discards the old screen's hierarchy`, async () => {
    const h = harness({ platform: "ios" });
    const result = await h.action.execute({
      direction: "up",
      ...(mode === "container" ? { container: { elementId: "list" } } : {}),
      ...(mode === "lookFor" ? { lookFor: { text: "Item 42" } } : {}),
    });
    if (mode === "container") {
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
      expect(h.voiceover.getCallCount()).toBe(0);
    } else {
      expect(result.success).toBe(true);
      expect(result.element?.bounds.left).toBe(liveBounds.left);
      expect(h.voiceover.getCallCount()).toBe(1);
      expect(h.voiceover.getSwipeCalls()[0].containerElement?.bounds).toEqual(liveBounds);
      expect(h.observe.getExecuteCallCount()).toBe(2);
      expect(h.ctrl.getHierarchyRequestCount()).toBe(0);
      if (mode === "lookFor") {
        expect(result.scrollIterations).toBe(1);
      }
    }
  });
}

for (const mode of ["screen", "container", "autoTarget", "lookFor"] as const) {
  test(`display ${mode} refreshes only when it resolves a hierarchy`, async () => {
    const h = displayHarness({ foundAfter: 0 });
    let cached = frame({ text: "Item 42" });
    const deviceRead = FakeObserveScreen.prototype.execute.bind(h.observe);
    spyOn(h.observe, "execute").mockImplementation(async (options) => {
      if (options?.freshness === "cached-ok") {
        return cached;
      }
      h.observe.setObserveResult(frame({ text: "Item 42" }));
      cached = await deviceRead(options);
      return cached;
    });
    const result = await h.action.execute({
      display: "external",
      direction: "up",
      ...(mode === "container" ? { container: { elementId: "item" } } : {}),
      ...(mode === "autoTarget" ? { autoTarget: true } : {}),
      ...(mode === "lookFor" ? { lookFor: { text: "Item 42" } } : {}),
    });
    expect(result.success).toBe(true);
    expect(h.observe.getExecuteCallCount()).toBe(mode === "lookFor" || mode === "screen" ? 1 : 2);
    const resolutionReads = h.observe
      .getExecuteOptions()
      .filter((options) => options.freshness === "fresh");
    expect(resolutionReads).toHaveLength(mode === "screen" ? 0 : 1);
    expect(resolutionReads.every((options) => options.display === "external")).toBe(true);
  });
}

test("display lookFor preserves a fresh preparation read in the nested search scope", async () => {
  const h = displayHarness({ foundAfter: 0 });
  let cached = frame({ text: "Item 42" });
  const deviceRead = FakeObserveScreen.prototype.execute.bind(h.observe);
  spyOn(h.observe, "execute").mockImplementation(async (options) => {
    if (h.observe.getExecuteCallCount() > 0) {
      return cached;
    }
    h.observe.setObserveResult(cached);
    cached = await deviceRead(options);
    return cached;
  });
  const result = await h.action.execute({
    display: "external",
    direction: "up",
    lookFor: { text: "Item 42" },
  });
  expect(result).toMatchObject({ success: true, found: true, scrollIterations: 0 });
  expect(h.observe.getExecuteCallCount()).toBe(1);
  expect(h.observe.getExecuteOptions()[0].freshness).toBe("cached-ok");
});
