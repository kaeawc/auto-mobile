import { beforeEach, describe, expect, test } from "bun:test";
import { ScrollUntilVisible } from "../../../../src/features/action/swipeon/ScrollUntilVisible";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeElementFinder } from "../../../fakes/FakeElementFinder";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import { FakeOverlayDetector } from "../../../fakes/FakeOverlayDetector";
import { FakeScrollAccessibilityService } from "../../../fakes/FakeScrollAccessibilityService";
import { FakeElementGeometry } from "../../../fakes/FakeElementGeometry";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import type { BootedDevice, Element, ObserveResult } from "../../../../src/models";
import type {
  SwipeOnResolvedOptions,
  TalkBackSwipeRunner,
  VoiceOverSwipeRunner,
} from "../../../../src/features/action/swipeon/types";
import type { FeatureFlagService } from "../../../../src/features/featureFlags/FeatureFlagService";
import { TalkBackSwipeExecutor } from "../../../../src/features/action/swipeon/TalkBackSwipeExecutor";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import type { ViewHierarchyResult } from "../../../../src/models";

const DEVICE: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "device-1",
};

const SCREEN_SIZE = { width: 400, height: 900 };

const makeObserveResult = (hierarchyId: number = 0): ObserveResult => ({
  timestamp: 0,
  screenSize: SCREEN_SIZE,
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy: {
    hierarchy: { node: { $: { _id: String(hierarchyId) } } },
  },
});

const CONTAINER_ELEMENT: Element = {
  bounds: { left: 0, top: 0, right: 400, bottom: 900 },
  "resource-id": "test:id/list",
  scrollable: true,
} as unknown as Element;

const TARGET_ELEMENT: Element = {
  bounds: { left: 10, top: 200, right: 390, bottom: 250 },
  "resource-id": "test:id/target",
  text: "Target Item",
  scrollable: false,
} as unknown as Element;

function makeScrollUntilVisible({
  accessibilityDetector,
  finder,
  timer,
  accessibilityService,
  observeResults,
  resolveObservation,
  talkBackExecutor,
  featureFlags,
  device = DEVICE,
  voiceOverExecutor,
}: {
  accessibilityDetector: FakeAccessibilityDetector;
  finder: FakeElementFinder;
  timer: FakeTimer;
  accessibilityService: FakeScrollAccessibilityService;
  observeResults: ObserveResult[];
  /**
   * Optional override for what the device "shows" at a given interaction index
   * (0 = before any swipe). Lets a test derive the observation from side effects
   * (e.g. which ACTION_SCROLL the fake service received) instead of a fixed list.
   */
  resolveObservation?: (callIdx: number) => ObserveResult;
  talkBackExecutor: TalkBackSwipeRunner;
  featureFlags?: FeatureFlagService;
  device?: BootedDevice;
  voiceOverExecutor?: VoiceOverSwipeRunner;
}): ScrollUntilVisible {
  let callIdx = 0;
  const observationAt = (idx: number): ObserveResult =>
    resolveObservation
      ? resolveObservation(idx)
      : observeResults[Math.min(idx, observeResults.length - 1)];

  const fakeObserveScreen = {
    execute: async () => observationAt(callIdx),
    getMostRecentCachedObserveResult: async () => observationAt(callIdx),
  };

  const fakeGeometry = new FakeElementGeometry();

  const fakeOverlayDetector = new FakeOverlayDetector();

  // Each observedInteraction call advances to the next observation
  const observedInteraction = async (action: (obs: ObserveResult) => Promise<any>, _opts: any) => {
    const obs = observationAt(callIdx);
    const result = await action(obs);
    callIdx++;
    const nextObs = observationAt(callIdx);
    return { ...result, observation: nextObs };
  };

  return new ScrollUntilVisible({
    device,
    finder: finder as any,
    geometry: fakeGeometry,
    observeScreen: fakeObserveScreen as any,
    accessibilityService,
    accessibilityDetector,
    adb: new FakeAdbClient() as any,
    featureFlags,
    overlayDetector: fakeOverlayDetector,
    talkBackExecutor,
    voiceOverExecutor,
    timer,
    getDuration: () => 300,
    resolveBoomerangConfig: () => undefined,
    buildPredictionArgs: () => ({}),
    observedInteraction,
  });
}

const BASE_OPTIONS: SwipeOnResolvedOptions = {
  direction: "up",
  lookFor: { text: "Target Item" },
};

describe("ScrollUntilVisible TalkBack focus behavior", () => {
  let detector: FakeAccessibilityDetector;
  let finder: FakeElementFinder;
  let timer: FakeTimer;
  let accessibilityService: FakeScrollAccessibilityService;
  let talkBackExecutor: FakeTalkBackSwipeExecutor;

  beforeEach(() => {
    detector = new FakeAccessibilityDetector();
    finder = new FakeElementFinder();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    accessibilityService = new FakeScrollAccessibilityService();
    talkBackExecutor = new FakeTalkBackSwipeExecutor();
  });

  describe("when TalkBack is disabled", () => {
    beforeEach(() => {
      detector.setTalkBackEnabled(false);
    });

    test("does not call requestAction(focus) even with focusTarget:true when element already visible", async () => {
      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      finder.nextElementByText = TARGET_ELEMENT;

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [makeObserveResult(0)],
        talkBackExecutor,
      });

      const result = await suv.execute({ ...BASE_OPTIONS, focusTarget: true });

      expect(result.success).toBe(true);
      expect(result.found).toBe(true);
      expect(accessibilityService.requestActionCalls).toHaveLength(0);
    });

    test("does not call requestAction(focus) when element found after scrolling", async () => {
      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      let findCount = 0;
      finder.findElementByText = (_h: any, _t: any) => {
        findCount++;
        return findCount > 1 ? TARGET_ELEMENT : null;
      };

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [makeObserveResult(0), makeObserveResult(1), makeObserveResult(2)],
        talkBackExecutor,
      });

      const result = await suv.execute({ ...BASE_OPTIONS, focusTarget: true });

      expect(result.success).toBe(true);
      expect(accessibilityService.requestActionCalls).toHaveLength(0);
    });
  });

  describe("when TalkBack is enabled", () => {
    beforeEach(() => {
      detector.setTalkBackEnabled(true);
    });

    test("passes the injected ADB executor (not null) to detectMethod (#3915 regression)", async () => {
      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      finder.nextElementByText = TARGET_ELEMENT;

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [makeObserveResult(0)],
        talkBackExecutor,
      });

      await suv.execute({ ...BASE_OPTIONS });

      // The bug passed `null`, which made TalkBack detection silently report
      // "not talkback" on a cold cache. Detection must receive the real executor.
      expect(detector.detectMethodAdbArgs.length).toBeGreaterThan(0);
      for (const arg of detector.detectMethodAdbArgs) {
        expect(arg).not.toBeNull();
      }
    });

    test("forwards the injected featureFlags to detectMethod (#3925 regression)", async () => {
      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      finder.nextElementByText = TARGET_ELEMENT;
      const sentinelFlags = { __sentinel: true } as unknown as FeatureFlagService;

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [makeObserveResult(0)],
        talkBackExecutor,
        featureFlags: sentinelFlags,
      });

      await suv.execute({ ...BASE_OPTIONS });

      expect(detector.detectMethodFeatureFlagsArgs.length).toBeGreaterThan(0);
      expect(detector.detectMethodFeatureFlagsArgs[0]).toBe(sentinelFlags);
    });

    test("does not call requestAction(focus) when focusTarget is not set and element already visible", async () => {
      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      finder.nextElementByText = TARGET_ELEMENT;

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [makeObserveResult(0)],
        talkBackExecutor,
      });

      const result = await suv.execute(BASE_OPTIONS);

      expect(result.success).toBe(true);
      expect(result.found).toBe(true);
      expect(accessibilityService.requestActionCalls).toHaveLength(0);
    });

    test("calls requestAction(focus, resourceId) when focusTarget:true and element already visible", async () => {
      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      finder.nextElementByText = TARGET_ELEMENT;

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [makeObserveResult(0)],
        talkBackExecutor,
      });

      const result = await suv.execute({ ...BASE_OPTIONS, focusTarget: true });

      expect(result.success).toBe(true);
      expect(result.found).toBe(true);
      expect(result.scrollIterations).toBe(0);
      expect(accessibilityService.requestActionCalls).toContainEqual({
        action: "focus",
        resourceId: "test:id/target",
        timeoutMs: 5000,
      });
    });

    test("calls requestAction(focus) after scrolling finds element with focusTarget:true", async () => {
      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      let findCount = 0;
      finder.findElementByText = (_h: any, _t: any) => {
        findCount++;
        return findCount > 1 ? TARGET_ELEMENT : null;
      };

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [makeObserveResult(0), makeObserveResult(1), makeObserveResult(2)],
        talkBackExecutor,
      });

      const result = await suv.execute({ ...BASE_OPTIONS, focusTarget: true });

      expect(result.success).toBe(true);
      expect(result.found).toBe(true);
      expect(result.scrollIterations).toBeGreaterThan(0);
      expect(accessibilityService.requestActionCalls).toContainEqual({
        action: "focus",
        resourceId: "test:id/target",
        timeoutMs: 5000,
      });
    });

    test("does not call requestAction(focus) after scrolling finds element without focusTarget", async () => {
      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      let findCount = 0;
      finder.findElementByText = (_h: any, _t: any) => {
        findCount++;
        return findCount > 1 ? TARGET_ELEMENT : null;
      };

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [makeObserveResult(0), makeObserveResult(1), makeObserveResult(2)],
        talkBackExecutor,
      });

      const result = await suv.execute(BASE_OPTIONS);

      expect(result.success).toBe(true);
      expect(accessibilityService.requestActionCalls).toHaveLength(0);
    });

    test("never calls requestAction(clear_focus) during scrolling", async () => {
      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      let findCount = 0;
      finder.findElementByText = (_h: any, _t: any) => {
        findCount++;
        return findCount > 2 ? TARGET_ELEMENT : null;
      };

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [
          makeObserveResult(0),
          makeObserveResult(1),
          makeObserveResult(2),
          makeObserveResult(3),
        ],
        talkBackExecutor,
      });

      await suv.execute({ ...BASE_OPTIONS, focusTarget: true });

      expect(accessibilityService.requestActionCalls.some((c) => c.action === "clear_focus")).toBe(
        false,
      );
    });

    test("skips focus if found element has no resource-id", async () => {
      const elementWithoutId: Element = {
        bounds: { left: 10, top: 200, right: 390, bottom: 250 },
        text: "Target Item",
        scrollable: false,
      } as unknown as Element;

      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      finder.nextElementByText = elementWithoutId;

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [makeObserveResult(0)],
        talkBackExecutor,
      });

      // Should succeed but not call requestAction since there's no resource-id to focus
      const result = await suv.execute({ ...BASE_OPTIONS, focusTarget: true });

      expect(result.success).toBe(true);
      expect(accessibilityService.requestActionCalls).toHaveLength(0);
    });

    test("succeeds even when requestAction(focus) throws", async () => {
      accessibilityService.setRequestActionThrows(new Error("focus action failed"));

      finder.nextScrollableContainer = CONTAINER_ELEMENT;
      finder.nextElementByText = TARGET_ELEMENT;

      const suv = makeScrollUntilVisible({
        accessibilityDetector: detector,
        finder,
        timer,
        accessibilityService,
        observeResults: [makeObserveResult(0)],
        talkBackExecutor,
      });

      const result = await suv.execute({ ...BASE_OPTIONS, focusTarget: true });

      expect(result.success).toBe(true);
      expect(result.found).toBe(true);
    });
  });
});

describe("ScrollUntilVisible TalkBack ACTION_SCROLL direction (#6116)", () => {
  // Marker the fake device puts on the hierarchy once the list has actually
  // scrolled forward (finger up) far enough to bring the target on screen.
  const TARGET_REVEALED = "target-revealed";

  const hierarchyShowsTarget = (hierarchy: ViewHierarchyResult): boolean =>
    (hierarchy.hierarchy as { node?: { $?: { _id?: string } } })?.node?.$?._id === TARGET_REVEALED;

  const makeRevealedObserveResult = (): ObserveResult => ({
    ...makeObserveResult(0),
    viewHierarchy: { hierarchy: { node: { $: { _id: TARGET_REVEALED } } } },
  });

  test("lookFor below the viewport (finger up) issues scroll_forward and finds the target on the first scroll", async () => {
    const detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(true);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fakeCtrlProxy = new FakeCtrlProxy();
    const finder = new FakeElementFinder();
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    // The target is only in the hierarchy once the device has scrolled forward.
    finder.findElementByText = (hierarchy: ViewHierarchyResult, _text: string) =>
      hierarchyShowsTarget(hierarchy) ? TARGET_ELEMENT : null;

    // Real executor + fake accessibility service: the fake "device" reveals the
    // target only after it receives scroll_forward. Anything else (the inverted
    // scroll_backward) leaves the list where it was.
    const talkBackExecutor = new TalkBackSwipeExecutor(
      DEVICE,
      new FakeGestureExecutor(),
      fakeCtrlProxy as any,
      detector,
      new FakeAdbClient() as any,
      timer,
    );
    const scrolledForward = () =>
      fakeCtrlProxy.getActionHistory().some((call) => call.action === "scroll_forward");
    const resolveObservation = (callIdx: number): ObserveResult =>
      callIdx > 0 && scrolledForward() ? makeRevealedObserveResult() : makeObserveResult(0);

    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService: new FakeScrollAccessibilityService(),
      observeResults: [],
      resolveObservation,
      talkBackExecutor,
    });

    // direction is the FINGER direction: swiping up reveals the content below.
    const result = await suv.execute({
      direction: "up",
      lookFor: { text: "Target Item", maxTime: 3000 },
    });

    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    // Toward the target on the very first scroll — no scroll_backward, and no
    // overshoot-recovery reversal needed to stumble onto it.
    expect(result.scrollIterations).toBe(1);
    expect(fakeCtrlProxy.getActionHistory().map((call) => call.action)).toEqual(["scroll_forward"]);
    expect(fakeCtrlProxy.getActionHistory()[0]).toMatchObject({
      resourceId: "test:id/list",
      timeoutMs: 5000,
    });
    expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(0);
  });
});

describe("ScrollUntilVisible VoiceOver behavior", () => {
  test("returns the VoiceOver unsupported result without dispatching a TalkBack or synthesized swipe", async () => {
    const finder = new FakeElementFinder();
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const talkBackExecutor = new FakeTalkBackSwipeExecutor();
    let voiceOverCalls = 0;
    const voiceOverExecutor: VoiceOverSwipeRunner = {
      async executeSwipeGesture(x1, y1, x2, y2, _direction, _container, gestureOptions) {
        voiceOverCalls++;
        return {
          success: false,
          error: "VoiceOver scrolling is not supported",
          fallbackReason: "XCTest-synthesized touches do not reach VoiceOver",
          x1,
          y1,
          x2,
          y2,
          duration: gestureOptions?.duration ?? 300,
        };
      },
    };

    const suv = makeScrollUntilVisible({
      accessibilityDetector: new FakeAccessibilityDetector(),
      finder,
      timer,
      accessibilityService: new FakeScrollAccessibilityService(),
      observeResults: [makeObserveResult(0)],
      talkBackExecutor,
      device: { name: "ios-device", platform: "ios", deviceId: "ios-1" },
      voiceOverExecutor,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("VoiceOver scrolling is not supported");
    expect(result.fallbackReason).toContain("do not reach VoiceOver");
    expect(voiceOverCalls).toBe(1);
    expect(talkBackExecutor.getCallCount()).toBe(0);
  });
});

describe("ScrollUntilVisible end-of-list detection", () => {
  let detector: FakeAccessibilityDetector;
  let finder: FakeElementFinder;
  let timer: FakeTimer;
  let accessibilityService: FakeScrollAccessibilityService;
  let talkBackExecutor: FakeTalkBackSwipeExecutor;

  beforeEach(() => {
    detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(true);
    finder = new FakeElementFinder();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    accessibilityService = new FakeScrollAccessibilityService();
    talkBackExecutor = new FakeTalkBackSwipeExecutor();
  });

  test("throws when hierarchy unchanged for maxUnchangedScrolls iterations", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    finder.nextElementByText = null; // never found

    // Same observation repeated — fingerprint will never change
    const sameObs = makeObserveResult(99);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [sameObs, sameObs, sameObs, sameObs, sameObs],
      talkBackExecutor,
    });

    await expect(suv.execute(BASE_OPTIONS)).rejects.toThrow(/Scroll reached end of container/);
  });

  test("continues scrolling when hierarchy changes between iterations", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    let findCount = 0;
    finder.findElementByText = (_h: any, _t: any) => {
      findCount++;
      return findCount > 3 ? TARGET_ELEMENT : null;
    };

    // Varying observations so fingerprint changes each scroll
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [
        makeObserveResult(0),
        makeObserveResult(1),
        makeObserveResult(2),
        makeObserveResult(3),
        makeObserveResult(4),
      ],
      talkBackExecutor,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    expect(result.scrollIterations).toBeGreaterThan(1);
  });

  test("resets unchanged count when hierarchy changes", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    let findCount = 0;
    finder.findElementByText = (_h: any, _t: any) => {
      findCount++;
      // Found after 3 calls: initial check + 1 forward miss + 1 reverse miss + found on 4th
      return findCount > 3 ? TARGET_ELEMENT : null;
    };

    // One same triggers reverseMode; subsequent changes in reverse reset the counter,
    // allowing continued scrolling until the element is found.
    const sameA = makeObserveResult(10);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [sameA, sameA, makeObserveResult(30), makeObserveResult(40)],
      talkBackExecutor,
    });

    // Should not throw — hierarchy changes during reverse reset the unchanged counter
    const result = await suv.execute(BASE_OPTIONS);
    expect(result.success).toBe(true);
  });
});
