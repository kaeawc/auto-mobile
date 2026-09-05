import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon";
import { ObserveResult } from "../../../../src/models";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { FakeAwaitIdle } from "../../../fakes/FakeAwaitIdle";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeElementFinder } from "../../../fakes/FakeElementFinder";
import type { Element, ViewHierarchyResult } from "../../../../src/models";

describe("SwipeOn TalkBack ACTION_SCROLL direction (#6116)", () => {
  const device = { name: "test-device", platform: "android", deviceId: "device-1" } as const;
  const LIST_ID = "test:id/list";
  const TARGET_REVEALED = "target-revealed";
  let fakeObserveScreen: FakeObserveScreen;
  let fakeGesture: FakeGestureExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeWindow: FakeWindow;
  let fakeTimer: FakeTimer;
  let fakeAccessibilityDetector: FakeAccessibilityDetector;
  let fakeCtrlProxy: FakeCtrlProxy;
  let finder: FakeElementFinder;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  const container: Element = {
    bounds: { left: 0, top: 0, right: 1000, bottom: 2000 },
    "resource-id": LIST_ID,
    scrollable: true,
  } as unknown as Element;

  const target: Element = {
    bounds: { left: 10, top: 500, right: 990, bottom: 600 },
    "resource-id": "test:id/target",
    text: "Target Item",
  } as unknown as Element;

  const createObserveResult = (hierarchyId: string): ObserveResult => ({
    timestamp: 0,
    screenSize: { width: 1000, height: 2000 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: { hierarchy: { node: { $: { _id: hierarchyId } } } },
  });

  const hierarchyShowsTarget = (hierarchy: ViewHierarchyResult): boolean =>
    (hierarchy.hierarchy as { node?: { $?: { _id?: string } } })?.node?.$?._id === TARGET_REVEALED;

  const scrolledForward = () =>
    fakeCtrlProxy.getActionHistory().some((call) => call.action === "scroll_forward");

  const createSwipeOn = () => {
    const swipeOn = new SwipeOn(device, {} as any, {
      executeGesture: fakeGesture,
      observeScreen: fakeObserveScreen,
      accessibilityDetector: fakeAccessibilityDetector,
      finder,
    });
    (swipeOn as any).awaitIdle = fakeAwaitIdle;
    (swipeOn as any).window = fakeWindow;
    (swipeOn as any).timer = fakeTimer;
    (swipeOn as any).scrollUntilVisible.deps.timer = fakeTimer;
    return swipeOn;
  };

  beforeEach(() => {
    fakeAccessibilityDetector = new FakeAccessibilityDetector();
    fakeAccessibilityDetector.setTalkBackEnabled(true);
    fakeCtrlProxy = new FakeCtrlProxy();
    // The real TalkBackSwipeExecutor inside SwipeOn talks to this fake service.
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeCtrlProxy as unknown as AndroidCtrlProxyClient,
    );
    fakeObserveScreen = new FakeObserveScreen();
    fakeGesture = new FakeGestureExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeWindow = new FakeWindow();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeWindow.configureCachedActiveWindow(null);
    finder = new FakeElementFinder();
    finder.nextScrollableContainer = container;
    finder.nextElementByResourceId = container;
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
  });

  test("lookFor target below the viewport with finger-up issues scroll_forward and reaches it in one scroll", async () => {
    // The fake device reveals the target only after the list has scrolled
    // forward; the inverted scroll_backward would leave it off screen.
    fakeObserveScreen.setObserveResult(() =>
      scrolledForward() ? createObserveResult(TARGET_REVEALED) : createObserveResult("top"),
    );
    finder.findElementByText = (hierarchy: ViewHierarchyResult, _text: string) =>
      hierarchyShowsTarget(hierarchy) ? target : null;

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "up",
      lookFor: { text: "Target Item", maxTime: 3000 },
    });

    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    expect(result.scrollIterations).toBe(1);
    expect(fakeCtrlProxy.getActionHistory().map((call) => call.action)).toEqual(["scroll_forward"]);
    expect(fakeCtrlProxy.getActionHistory()[0]).toMatchObject({ resourceId: LIST_ID });
    expect(fakeGesture.getSwipeCalls()).toHaveLength(0);
  });

  test("scrollTowardsDirection down resolves to finger-up and issues the same content motion as the coordinate path", async () => {
    fakeObserveScreen.setObserveResult(createObserveResult("top"));
    const options = {
      direction: "down",
      gestureType: "scrollTowardsDirection",
      container: { elementId: LIST_ID },
    } as const;

    // Reference: with TalkBack off the same request moves the finger UP
    // (startY > endY), which reveals the content below.
    fakeAccessibilityDetector.setTalkBackEnabled(false);
    const coordinateResult = await createSwipeOn().execute(options);
    expect(coordinateResult.success).toBe(true);
    const fingerSwipe = fakeGesture.getSwipeCalls();
    expect(fingerSwipe).toHaveLength(1);
    expect(fingerSwipe[0].y1).toBeGreaterThan(fingerSwipe[0].y2);

    // Under TalkBack the same request must scroll the content the same way:
    // finger up == ACTION_SCROLL_FORWARD.
    fakeAccessibilityDetector.setTalkBackEnabled(true);
    fakeAccessibilityDetector.invalidateCache(device.deviceId);
    const talkBackResult = await createSwipeOn().execute(options);
    expect(talkBackResult.success).toBe(true);
    expect(fakeCtrlProxy.getActionHistory().map((call) => call.action)).toEqual(["scroll_forward"]);
    expect(fakeCtrlProxy.getActionHistory()[0]).toMatchObject({ resourceId: LIST_ID });
    expect(fakeGesture.getSwipeCalls()).toHaveLength(1);
  });
});

describe("SwipeOn boomerang", () => {
  const device = { name: "test-device", platform: "android", deviceId: "device-1" } as const;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeGesture: FakeGestureExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeWindow: FakeWindow;
  let fakeTimer: FakeTimer;
  let fakeAccessibilityDetector: FakeAccessibilityDetector;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  const createObserveResult = (): ObserveResult => ({
    timestamp: Date.now(),
    screenSize: { width: 1000, height: 2000 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: null,
  });

  const createSwipeOn = () => {
    const swipeOn = new SwipeOn(device, {} as any, {
      executeGesture: fakeGesture,
      observeScreen: fakeObserveScreen,
      accessibilityDetector: fakeAccessibilityDetector,
    });
    (swipeOn as any).awaitIdle = fakeAwaitIdle;
    (swipeOn as any).window = fakeWindow;
    (swipeOn as any).timer = fakeTimer;
    return swipeOn;
  };

  beforeEach(() => {
    fakeAccessibilityDetector = new FakeAccessibilityDetector();
    fakeAccessibilityDetector.setTalkBackEnabled(false);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      {} as AndroidCtrlProxyClient,
    );
    fakeObserveScreen = new FakeObserveScreen();
    fakeGesture = new FakeGestureExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeWindow = new FakeWindow();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeWindow.configureCachedActiveWindow(null);
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
  });

  test("performs a round-trip swipe with return speed", async () => {
    fakeObserveScreen.setObserveResult(createObserveResult());

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "up",
      autoTarget: false,
      duration: 400,
      boomerang: true,
      apexPause: 0,
      returnSpeed: 2,
    });

    expect(result.success).toBe(true);
    expect(result.duration).toBe(600);

    const calls = fakeGesture.getSwipeCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].options?.duration).toBe(400);
    expect(calls[1].options?.duration).toBe(200);
    expect(calls[1].x1).toBe(calls[0].x2);
    expect(calls[1].y1).toBe(calls[0].y2);
    expect(calls[1].x2).toBe(calls[0].x1);
    expect(calls[1].y2).toBe(calls[0].y1);
  });
});

describe("SwipeOn lookFor validation", () => {
  const device = { name: "test-device", platform: "android", deviceId: "device-1" } as const;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeGesture: FakeGestureExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeWindow: FakeWindow;
  let fakeTimer: FakeTimer;
  let fakeAccessibilityDetector: FakeAccessibilityDetector;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  const createSwipeOn = () => {
    const swipeOn = new SwipeOn(device, {} as any, {
      executeGesture: fakeGesture,
      observeScreen: fakeObserveScreen,
      accessibilityDetector: fakeAccessibilityDetector,
    });
    (swipeOn as any).awaitIdle = fakeAwaitIdle;
    (swipeOn as any).window = fakeWindow;
    (swipeOn as any).timer = fakeTimer;
    return swipeOn;
  };

  beforeEach(() => {
    fakeAccessibilityDetector = new FakeAccessibilityDetector();
    fakeAccessibilityDetector.setTalkBackEnabled(false);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      {} as AndroidCtrlProxyClient,
    );
    fakeObserveScreen = new FakeObserveScreen();
    fakeGesture = new FakeGestureExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeWindow = new FakeWindow();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeWindow.configureCachedActiveWindow(null);
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
  });

  test("rejects lookFor without text or elementId", async () => {
    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "up",
      lookFor: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("lookFor must specify exactly one of elementId or text");
  });

  test("rejects lookFor with both text and elementId", async () => {
    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "up",
      lookFor: {
        text: "Settings",
        elementId: "com.app:id/settings",
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("lookFor must specify exactly one of elementId or text");
  });
});
