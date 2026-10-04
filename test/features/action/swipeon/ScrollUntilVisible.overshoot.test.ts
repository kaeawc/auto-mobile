import { loadIosRemindersNoiseObservePair } from "../../../fixtures/observe/observeFixture";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import type { ElementGeometry } from "../../../../src/utils/interfaces/ElementGeometry";
import { FakeScrollElementResolver } from "../../../fakes/FakeScrollElementResolver";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ScrollUntilVisible } from "../../../../src/features/action/swipeon/ScrollUntilVisible";
import { ElementResolver } from "../../../../src/features/utility/ElementResolver";
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
  OverlayCandidate,
  SwipeOnResolvedOptions,
} from "../../../../src/features/action/swipeon/types";

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
  text: "Skills",
  scrollable: false,
} as unknown as Element;

function makeScrollUntilVisible({
  accessibilityDetector,
  finder,
  timer,
  accessibilityService,
  observeResults,
  talkBackExecutor,
  getDuration,
  overlayDetector,
  observeOptions,
  observedInteractionOptions,
  terminalEvidence,
  resolver,
  onInteraction,
  device = DEVICE,
  geometry,
}: {
  accessibilityDetector: FakeAccessibilityDetector;
  finder: FakeElementFinder;
  timer: FakeTimer;
  accessibilityService: FakeScrollAccessibilityService;
  observeResults: ObserveResult[];
  talkBackExecutor: FakeTalkBackSwipeExecutor;
  getDuration?: (options: SwipeOnResolvedOptions) => number;
  overlayDetector?: FakeOverlayDetector;
  observeOptions?: Array<Record<string, unknown> | undefined>;
  observedInteractionOptions?: Array<Record<string, unknown>>;
  terminalEvidence?: ObserveResult[];
  resolver?: ElementResolver;
  onInteraction?: () => void;
  device?: BootedDevice;
  geometry?: ElementGeometry;
}): ScrollUntilVisible {
  let callIdx = 0;

  const fakeObserveScreen = {
    execute: async (options?: Record<string, unknown>) => {
      observeOptions?.push(options);
      return observeResults[Math.min(callIdx, observeResults.length - 1)];
    },
    getMostRecentCachedObserveResult: async () =>
      observeResults[Math.min(callIdx, observeResults.length - 1)],
  };

  const fakeGeometry = new FakeElementGeometry();

  const fakeOverlayDetector = overlayDetector ?? new FakeOverlayDetector();

  const observedInteraction = async (action: (obs: ObserveResult) => Promise<any>, opts: any) => {
    observedInteractionOptions?.push(opts);
    const obs = observeResults[Math.min(callIdx, observeResults.length - 1)];
    const result = await action(obs);
    onInteraction?.();
    callIdx++;
    const nextObs = observeResults[Math.min(callIdx, observeResults.length - 1)];
    return { ...result, observation: nextObs };
  };

  return new ScrollUntilVisible({
    device,
    resolver: resolver ?? new FakeScrollElementResolver(finder),
    geometry: geometry ?? fakeGeometry,
    observeScreen: fakeObserveScreen as any,
    accessibilityService,
    accessibilityDetector,
    adb: new FakeAdbClient() as any,
    overlayDetector: fakeOverlayDetector,
    talkBackExecutor,
    voiceOverExecutor: talkBackExecutor,
    timer,
    getDuration: getDuration ?? (() => 300),
    resolveBoomerangConfig: () => undefined,
    buildPredictionArgs: () => ({}),
    observedInteraction,
    captureTerminalObservationScreenshot: async (observation) => {
      if (observation) {
        terminalEvidence?.push(observation);
      }
    },
  });
}

const BASE_OPTIONS: SwipeOnResolvedOptions = {
  direction: "up",
  lookFor: { text: "Skills" },
};

describe("ScrollUntilVisible overshoot recovery", () => {
  let detector: FakeAccessibilityDetector;
  let finder: FakeElementFinder;
  let timer: FakeTimer;
  let accessibilityService: FakeScrollAccessibilityService;
  let talkBackExecutor: FakeTalkBackSwipeExecutor;

  beforeEach(() => {
    detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(false);
    finder = new FakeElementFinder();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    accessibilityService = new FakeScrollAccessibilityService();
    talkBackExecutor = new FakeTalkBackSwipeExecutor();
  });

  test("lookFor scroll resolution leaves hint fallback off for a filled Android field", () => {
    const resolver = new ElementResolver();
    const resolve = spyOn(resolver, "resolve");
    const scroll = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [makeObserveResult()],
      talkBackExecutor,
      resolver,
    });
    try {
      const hierarchy = {
        hierarchy: {
          node: {
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            class: "android.widget.EditText",
            text: "5551234",
            "hint-text": "Phone",
            focusable: true,
          },
        },
      };
      expect(scroll.resolveElement(hierarchy, { text: "Phone" }, "inspect", true)).toBeNull();
      expect(resolve.mock.calls[0][2].allowHintFallback).toBeUndefined();
      expect(resolve.mock.calls[0][2].action).toBe("inspect");
    } finally {
      resolve.mockRestore();
    }
  });

  test("already aborted scroll observes no device state", async () => {
    const observeOptions: Array<Record<string, unknown> | undefined> = [];
    const scroll = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [makeObserveResult()],
      talkBackExecutor,
      observeOptions,
    });
    await expect(
      scroll.execute(BASE_OPTIONS, undefined, undefined, AbortSignal.abort()),
    ).rejects.toThrow("Operation cancelled");
    expect(observeOptions).toEqual([]);
    expect(talkBackExecutor.getSwipeCalls()).toEqual([]);
  });

  test("abort after a scroll iteration prevents the next poll or gesture", async () => {
    const controller = new AbortController();
    const scroll = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [makeObserveResult(), makeObserveResult(1)],
      talkBackExecutor,
      onInteraction: () => controller.abort(),
    });
    await expect(
      scroll.execute(BASE_OPTIONS, undefined, undefined, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(talkBackExecutor.getSwipeCalls()).toHaveLength(1);
  });

  test("automatic scrolling keeps the outer scrollable ahead of a nested carousel", async () => {
    const observation: ObserveResult = {
      ...makeObserveResult(),
      viewHierarchy: {
        hierarchy: {
          node: {
            bounds: { left: 0, top: 0, right: 400, bottom: 900 },
            "resource-id": "feed",
            scrollable: true,
            node: [
              {
                bounds: { left: 10, top: 100, right: 390, bottom: 300 },
                "resource-id": "carousel",
                scrollable: true,
              },
            ],
          },
        },
      },
    };
    const scroll = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [observation],
      talkBackExecutor,
      resolver: new ElementResolver(),
    });
    expect((await scroll.findScrollableContainer(BASE_OPTIONS, observation))["resource-id"]).toBe(
      "feed",
    );
  });

  test("automatic scrolling uses the app feed before an IME overlay", async () => {
    const observation: ObserveResult = {
      ...makeObserveResult(),
      viewHierarchy: {
        hierarchy: {
          node: {
            bounds: { left: 0, top: 0, right: 400, bottom: 900 },
            "resource-id": "app:id/feed",
            scrollable: true,
          },
        },
        windows: [
          {
            windowLayer: 10,
            hierarchy: {
              node: {
                bounds: { left: 0, top: 700, right: 400, bottom: 900 },
                "resource-id": "ime:id/suggestions",
                scrollable: true,
              },
            },
          },
        ],
      },
    };
    const scroll = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [observation],
      talkBackExecutor,
      resolver: new ElementResolver(),
    });
    expect((await scroll.findScrollableContainer(BASE_OPTIONS, observation))["resource-id"]).toBe(
      "app:id/feed",
    );
  });

  test("element found in reverse after forward end-of-list", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;

    // Forward phase: obs[1] same as obs[0] → 1 unchanged scroll → switch to reverseMode
    // Reverse phase: obs[2] is different fingerprint → element found
    let findCount = 0;
    finder.findElementByText = (_h: any, _t: any) => {
      findCount++;
      // found on the 3rd call (initial check + 1 forward miss + found after reverse)
      return findCount >= 3 ? TARGET_ELEMENT : null;
    };

    const sameObs = makeObserveResult(0);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      // [0]=initial, [1]=same fingerprint (forward end), [2]=different (reverse finds element)
      observeResults: [sameObs, sameObs, makeObserveResult(1)],
      talkBackExecutor,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    expect(result.scrollIterations).toBeGreaterThan(0);
  });

  test("throws when both forward and reverse directions exhaust without finding element", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    finder.nextElementByText = null; // never found

    // All observations identical — both forward and reverse end-of-list trigger
    const sameObs = makeObserveResult(99);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [sameObs, sameObs, sameObs, sameObs, sameObs, sameObs, sameObs, sameObs],
      talkBackExecutor,
    });

    await expect(suv.execute(BASE_OPTIONS)).rejects.toThrow(/Scroll reached end of container/);
  });

  test("element found in forward direction without entering reverse mode", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;

    let findCount = 0;
    finder.findElementByText = (_h: any, _t: any) => {
      findCount++;
      // found after 2 forward scrolls (findCount=3: initial check + 2 post-swipe checks)
      return findCount >= 3 ? TARGET_ELEMENT : null;
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

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);

    // Verify that executeSwipeGesture was never called with the reversed direction ("down")
    const allDirections = talkBackExecutor.getDirections();
    expect(allDirections.every((d) => d === "up")).toBe(true);
  });

  test("suppresses intermediate evidence and captures only the terminal observation", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    let findCount = 0;
    finder.findElementByText = (_h: any, _t: any) => {
      findCount++;
      return findCount >= 2 ? TARGET_ELEMENT : null;
    };
    const observeOptions: Array<Record<string, unknown> | undefined> = [];
    const observedInteractionOptions: Array<Record<string, unknown>> = [];
    const terminalEvidence: ObserveResult[] = [];
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [makeObserveResult(0), makeObserveResult(1)],
      talkBackExecutor,
      observeOptions,
      observedInteractionOptions,
      terminalEvidence,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(observeOptions).not.toHaveLength(0);
    expect(observeOptions.every((options) => options?.skipScreenshot === true)).toBe(true);
    expect(observeOptions.every((options) => options?.skipAccessibilityAudit === true)).toBe(true);
    expect(
      observedInteractionOptions.every((options) => options.deferPostActionScreenshot === true),
    ).toBe(true);
    expect(terminalEvidence).toEqual([result.observation]);
  });

  test("switches to opposite direction after forward end-of-list", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;

    // Forward phase triggers end-of-list (1 same), then reverse finds element
    let findCount = 0;
    finder.findElementByText = (_h: any, _t: any) => {
      findCount++;
      return findCount >= 3 ? TARGET_ELEMENT : null;
    };

    const sameObs = makeObserveResult(0);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [sameObs, sameObs, makeObserveResult(1)],
      talkBackExecutor,
    });

    await suv.execute(BASE_OPTIONS);

    const allDirections = talkBackExecutor.getDirections();

    // Forward swipes should be "up", reverse swipe should be "down"
    expect(allDirections).toContain("up");
    expect(allDirections).toContain("down");

    // The last call should be the reversed direction
    expect(allDirections[allDirections.length - 1]).toBe("down");
  });

  test("stale unchanged observation is re-observed before deciding to reverse", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    let findCount = 0;
    finder.findElementByText = () => (++findCount >= 3 ? TARGET_ELEMENT : null);

    const initial = makeObserveResult(0);
    const stale = { ...makeObserveResult(0), freshness: { isFresh: false } };
    const moved = makeObserveResult(1);
    const final = makeObserveResult(2);
    let repeatedObservationReads = 0;
    const observeResults = new Proxy([initial, stale, final], {
      get(results, property, receiver) {
        if (property === "1") {
          repeatedObservationReads++;
          // The swipe result and idle poll are stale; the direct corroborating
          // capture, then the next swipe's starting frame, show movement.
          return repeatedObservationReads <= 2 ? stale : moved;
        }
        return Reflect.get(results, property, receiver);
      },
    });
    const observeOptions: Array<Record<string, unknown> | undefined> = [];
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults,
      talkBackExecutor,
      observeOptions,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    expect(talkBackExecutor.getDirections()).toEqual(["up", "up"]);
    expect(observeOptions).toHaveLength(4); // initial, idle, corroboration, next idle
    expect(observeOptions.map((options) => options?.freshness)).toEqual(Array(4).fill("cached-ok"));
    expect(repeatedObservationReads).toBeGreaterThanOrEqual(3);
  });

  test("fresh unchanged observation still enters reverse mode", async () => {
    const firstContainer = {
      ...CONTAINER_ELEMENT,
      bounds: { left: 0, top: 0, right: 400, bottom: 900 },
    };
    const shiftedContainer = {
      ...CONTAINER_ELEMENT,
      bounds: { left: 100, top: 100, right: 300, bottom: 700 },
    };
    let containerLookups = 0;
    finder.findScrollableContainer = () =>
      ++containerLookups === 1 ? firstContainer : shiftedContainer;
    let findCount = 0;
    finder.findElementByText = () => (++findCount >= 3 ? TARGET_ELEMENT : null);
    const sameObs = { ...makeObserveResult(0), freshness: { isFresh: true } };
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [sameObs, sameObs, makeObserveResult(1)],
      talkBackExecutor,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    expect(talkBackExecutor.getDirections()).toEqual(["up", "down"]);
    expect(talkBackExecutor.getSwipeCalls()[1]).toMatchObject({
      x1: 200,
      y1: 250,
      x2: 200,
      y2: 550,
    });
  });

  test("uses shifted container bounds for the post-swipe target check", async () => {
    const firstContainer = {
      ...CONTAINER_ELEMENT,
      bounds: { left: 0, top: 0, right: 200, bottom: 900 },
    };
    const shiftedContainer = {
      ...CONTAINER_ELEMENT,
      bounds: { left: 200, top: 100, right: 400, bottom: 700 },
    };
    const shiftedTarget = {
      ...TARGET_ELEMENT,
      bounds: { left: 250, top: 200, right: 300, bottom: 250 },
    };
    let containerLookups = 0;
    finder.findScrollableContainer = () =>
      ++containerLookups === 1 ? firstContainer : shiftedContainer;
    let findCount = 0;
    finder.findElementByText = () => (++findCount >= 2 ? shiftedTarget : null);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [makeObserveResult(0), makeObserveResult(1)],
      talkBackExecutor,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    expect(result.element).toEqual(shiftedTarget);
    expect(result.scrollIterations).toBe(1);
    expect(containerLookups).toBeGreaterThan(1);
  });

  test("keeps last-known container bounds when a later observation has none", async () => {
    const lastKnownContainer = {
      ...CONTAINER_ELEMENT,
      bounds: { left: 50, top: 100, right: 350, bottom: 700 },
    };
    let containerLookups = 0;
    finder.findScrollableContainer = () => (++containerLookups === 1 ? lastKnownContainer : null);
    let findCount = 0;
    finder.findElementByText = () => (++findCount >= 3 ? TARGET_ELEMENT : null);
    const sameObs = makeObserveResult(0);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [sameObs, sameObs, makeObserveResult(1)],
      talkBackExecutor,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    expect(containerLookups).toBeGreaterThan(1);
    expect(talkBackExecutor.getSwipeCalls()[1]).toMatchObject({
      direction: "down",
      x1: 200,
      y1: 250,
      x2: 200,
      y2: 550,
      containerElement: lastKnownContainer,
    });
  });

  test("scroll idle detection: uses settled observation when swipe returns mid-scroll state", async () => {
    // Scenario: observedInteraction returns a mid-scroll hierarchy (hierarchyId=1).
    // Direct execute() calls for idle polling return a different obs (hierarchyId=2) first,
    // then the same obs again (hierarchyId=2) → fingerprints match → settled.
    // The element is only findable in the settled state (call 2+).
    const obs0 = makeObserveResult(0); // initial
    const obs1mid = makeObserveResult(1); // mid-scroll returned by observedInteraction
    const obs2settled = makeObserveResult(2); // settled (idle poll 1 and 2 both return this)

    let executeCallCount = 0;
    const fakeObserveScreen = {
      execute: async () => {
        executeCallCount++;
        if (executeCallCount === 1) {
          return obs0;
        } // initial observe
        // Idle polls: first sees obs2settled (different from obs1mid → sleep),
        // second also sees obs2settled (same → settled)
        return obs2settled;
      },
      getMostRecentCachedObserveResult: async () => obs0,
      appendRawViewHierarchy: async () => {},
    };

    const fakeGeometry = new FakeElementGeometry();
    const fakeOverlayDetector = new FakeOverlayDetector();
    const fakeDetector = new FakeAccessibilityDetector();
    fakeDetector.setTalkBackEnabled(false);
    const fakeFinder = new FakeElementFinder();
    fakeFinder.nextScrollableContainer = CONTAINER_ELEMENT;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const fakeTalkBack = new FakeTalkBackSwipeExecutor();
    const fakeAccessibilityService = new FakeScrollAccessibilityService();

    // Element not found initially; found after idle poll settles to obs2settled
    let findCount = 0;
    fakeFinder.findElementByText = (_h: any, _t: any) => {
      findCount++;
      return findCount >= 2 ? TARGET_ELEMENT : null;
    };

    // observedInteraction: always returns obs1mid as the post-swipe observation
    const observedInteraction = async (
      action: (obs: ObserveResult) => Promise<any>,
      _opts: any,
    ) => {
      const result = await action(obs0);
      return { ...result, observation: obs1mid };
    };

    const suv = new ScrollUntilVisible({
      device: DEVICE,
      resolver: new FakeScrollElementResolver(fakeFinder),
      geometry: fakeGeometry,
      observeScreen: fakeObserveScreen as any,
      accessibilityService: fakeAccessibilityService,
      accessibilityDetector: fakeDetector,
      adb: new FakeAdbClient() as any,
      overlayDetector: fakeOverlayDetector,
      talkBackExecutor: fakeTalkBack,
      timer: fakeTimer,
      getDuration: () => 300,
      resolveBoomerangConfig: () => undefined,
      buildPredictionArgs: () => ({}),
      observedInteraction,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    // Verify idle polls occurred: 1 initial + at least 2 idle polls
    expect(executeCallCount).toBeGreaterThanOrEqual(3);
  });

  test("scroll idle detection: no extra sleep when observation already settled", async () => {
    // When observedInteraction and the first idle poll return the same fingerprint,
    // waitForScrollIdle returns immediately without sleeping.
    finder.nextScrollableContainer = CONTAINER_ELEMENT;

    let findCount = 0;
    finder.findElementByText = (_h: any, _t: any) => {
      findCount++;
      return findCount >= 3 ? TARGET_ELEMENT : null;
    };

    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      // All distinct so fingerprints keep changing → scroll detected each iteration
      observeResults: [
        makeObserveResult(0),
        makeObserveResult(1),
        makeObserveResult(2),
        makeObserveResult(3),
      ],
      talkBackExecutor,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    // In the existing helper, idle polls see the same obs as observedInteraction returned
    // → settle immediately. Sleep calls should only come from other sources, not idle polling.
    // Timer is in auto-advance mode so no pending sleeps remain.
    expect(timer.getPendingSleepCount()).toBe(0);
  });

  test("reverse mode uses slow speed even when original options had fast speed", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;

    // Forward phase triggers end-of-list (1 same), reverse finds element
    let findCount = 0;
    finder.findElementByText = (_h: any, _t: any) => {
      findCount++;
      return findCount >= 3 ? TARGET_ELEMENT : null;
    };

    const getDurationCalls: SwipeOnResolvedOptions[] = [];
    const getDuration = (opts: SwipeOnResolvedOptions) => {
      getDurationCalls.push({ ...opts });
      return 300;
    };

    const sameObs = makeObserveResult(0);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [sameObs, sameObs, makeObserveResult(1)],
      talkBackExecutor,
      getDuration,
    });

    // Use fast speed to verify it gets overridden to slow in reverse mode
    await suv.execute({ ...BASE_OPTIONS, speed: "fast" });

    // The last getDuration call corresponds to the reverse swipe — must use "slow"
    const lastCall = getDurationCalls[getDurationCalls.length - 1];
    expect(lastCall.speed).toBe("slow");
  });

  test("uses safe swipe coordinates from overlay detector when overlay is present", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;

    let findCount = 0;
    finder.findElementByText = (_h: any, _t: any) => (++findCount >= 2 ? TARGET_ELEMENT : null);

    const overlayDetector = new FakeOverlayDetector();
    const candidate: OverlayCandidate = {
      bounds: { left: 0, top: 0, right: 400, bottom: 200 },
      overlapBounds: { left: 0, top: 0, right: 400, bottom: 200 },
      coverage: 80000,
      zOrder: { windowRank: 1, nodeOrder: 0 },
    };
    overlayDetector.candidates = [candidate];
    overlayDetector.safeCoords = { startX: 50, startY: 600, endX: 50, endY: 300 };

    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [makeObserveResult(0), makeObserveResult(1), makeObserveResult(2)],
      talkBackExecutor,
      overlayDetector,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    const firstSwipe = talkBackExecutor.getSwipeCalls()[0];
    expect(firstSwipe.x1).toBe(50);
  });

  test("indeterminate Android swipe stops before retry or reverse recovery", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    const error =
      "Swipe outcome is indeterminate: the request was dispatched but no result was confirmed (timeout). Do not retry automatically.";
    const failure = { success: false, outcomeIndeterminate: true, error };
    talkBackExecutor.setFailureResult(failure);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [makeObserveResult()],
      talkBackExecutor,
      onInteraction: () => talkBackExecutor.setFailureResult(failure),
    });

    await expect(suv.execute(BASE_OPTIONS)).rejects.toThrow(
      `${error} The scroll may have happened. Observe before retrying.`,
    );
    expect(talkBackExecutor.getDirections()).toEqual(["up"]);
  });

  test("two consecutive definite Android swipe failures report the swipe error without reversing", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    const failure = { success: false, error: "adb: device offline" };
    talkBackExecutor.setFailureResult(failure);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [makeObserveResult()],
      talkBackExecutor,
      onInteraction: () => talkBackExecutor.setFailureResult(failure),
    });

    await expect(suv.execute(BASE_OPTIONS)).rejects.toThrow(
      "Scroll swipe failed: adb: device offline",
    );
    expect(talkBackExecutor.getDirections()).toEqual(["up", "up"]);
  });

  test("one definite Android failure with an unchanged hierarchy does not trigger reverse recovery", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    let findCount = 0;
    finder.findElementByText = () => (++findCount >= 3 ? TARGET_ELEMENT : null);
    talkBackExecutor.setFailureResult({ success: false, error: "gesture rejected" });
    const sameObs = makeObserveResult();
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [sameObs, sameObs, makeObserveResult(1)],
      talkBackExecutor,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    expect(talkBackExecutor.getDirections()).toEqual(["up", "up"]);
  });

  test("a successful Android swipe resets the consecutive failure allowance", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    let findCount = 0;
    finder.findElementByText = () => (++findCount >= 5 ? TARGET_ELEMENT : null);
    const failure = { success: false, error: "gesture rejected" };
    talkBackExecutor.setFailureResult(failure);
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [0, 1, 2, 3, 4].map(makeObserveResult),
      talkBackExecutor,
      onInteraction: () => {
        if (talkBackExecutor.getCallCount() === 2) {
          talkBackExecutor.setFailureResult(failure);
        }
      },
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    expect(talkBackExecutor.getDirections()).toEqual(["up", "up", "up", "up"]);
  });

  test("timeout after a tolerated Android failure retains the swipe error", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    talkBackExecutor.setFailureResult({ success: false, error: "adb: device offline" });
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [makeObserveResult()],
      talkBackExecutor,
      onInteraction: () => timer.advanceTime(10),
    });

    await expect(
      suv.execute({ ...BASE_OPTIONS, lookFor: { text: "Skills", maxTime: 10 } }),
    ).rejects.toThrow("Scroll swipe failed: adb: device offline");
    expect(talkBackExecutor.getDirections()).toEqual(["up"]);
  });

  test("successful unchanged swipes preserve the end-of-container message", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [makeObserveResult()],
      talkBackExecutor,
    });

    await expect(suv.execute(BASE_OPTIONS)).rejects.toThrow(
      'Scroll reached end of container (no change after 1 scrolls). text "Skills" not found after 2 iterations (0ms).',
    );
    expect(talkBackExecutor.getDirections()).toEqual(["up", "down"]);
  });

  test("failed iOS swipe still returns the original failure after one swipe", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;
    talkBackExecutor.setFailureResult({ success: false, error: "gesture rejected" });
    const observation = makeObserveResult();
    const terminalEvidence: ObserveResult[] = [];
    const suv = makeScrollUntilVisible({
      accessibilityDetector: detector,
      finder,
      timer,
      accessibilityService,
      observeResults: [observation],
      talkBackExecutor,
      device: { ...DEVICE, platform: "ios" },
      terminalEvidence,
    });

    const result = await suv.execute(BASE_OPTIONS);

    expect(result).toMatchObject({
      success: false,
      error: "gesture rejected",
      targetType: "screen",
      found: false,
      scrollIterations: 1,
      elapsedMs: 0,
      observation,
    });
    expect(talkBackExecutor.getDirections()).toEqual(["up"]);
    expect(terminalEvidence).toEqual([observation]);
  });

  test("scroll proceeds past a failed swipe if observation is still returned", async () => {
    finder.nextScrollableContainer = CONTAINER_ELEMENT;

    let findCount = 0;
    finder.findElementByText = (_h: any, _t: any) => (++findCount >= 3 ? TARGET_ELEMENT : null);

    talkBackExecutor.setFailureResult({ success: false, error: "gesture rejected" });

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

    const result = await suv.execute(BASE_OPTIONS);

    expect(result.success).toBe(true);
    expect(talkBackExecutor.getDirections()).toEqual(["up", "up"]);
  });
});

describe("ScrollUntilVisible shared resolver identity", () => {
  const hierarchy = (ids: string[]) => ({
    hierarchy: {
      node: ids.map((id, index) => ({
        "resource-id": id,
        bounds: { left: 0, top: index * 50, right: 100, bottom: index * 50 + 40 },
      })),
    },
  });
  test("bare lookFor ID rejects substring near misses", async () => {
    const { DefaultElementFinder } = await import("../../../../src/features/utility/ElementFinder");
    const scroll = new ScrollUntilVisible({ finder: new DefaultElementFinder() } as any);
    const result = await scroll.findElementInHierarchy(
      { elementId: "btn_login" },
      hierarchy(["com.app:id/btn_login_help"]) as any,
    );
    expect(result).toBeNull();
  });
  test("bare lookFor ID reports candidate packages when ambiguous", async () => {
    const { DefaultElementFinder } = await import("../../../../src/features/utility/ElementFinder");
    const scroll = new ScrollUntilVisible({ finder: new DefaultElementFinder() } as any);
    await expect(
      scroll.findElementInHierarchy(
        { elementId: "btn_login" },
        hierarchy(["com.one:id/btn_login", "com.two:id/btn_login"]) as any,
      ),
    ).rejects.toThrow(/com.one:id\/btn_login.*com.two:id\/btn_login/);
  });
  test("text lookFor keeps the matched label rather than its clickable row", async () => {
    const scroll = new ScrollUntilVisible({} as any);
    const label = {
      "resource-id": "com.app:id/target_label",
      text: "Target",
      bounds: { left: 0, top: 80, right: 100, bottom: 100 },
    };
    const found = await scroll.findElementInHierarchy({ text: "Target" }, {
      hierarchy: {
        node: {
          "resource-id": "com.app:id/target_row",
          clickable: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          node: [label],
        },
      },
    } as any);
    expect(found?.["resource-id"]).toBe("com.app:id/target_label");
    expect(found?.bounds).toEqual(label.bounds);
  });
  test("explicit text swipe keeps matched label bounds, while ID uses the selected row", async () => {
    const scroll = new ScrollUntilVisible({} as any);
    const label = { text: "Target", bounds: { left: 20, top: 40, right: 80, bottom: 60 } };
    const viewHierarchy = {
      hierarchy: {
        node: {
          "resource-id": "row",
          clickable: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          node: [label],
        },
      },
    } as any;
    expect(
      (await scroll.findTargetElement({ container: { text: "Target" } } as any, viewHierarchy))
        .bounds,
    ).toEqual(label.bounds);
    expect(
      (await scroll.findTargetElement({ container: { elementId: "row" } } as any, viewHierarchy))
        .bounds,
    ).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
  });
  test("text lookFor skips unrelated text on the promoted row", async () => {
    const scroll = new ScrollUntilVisible({} as any);
    const target = { text: "Target", bounds: { left: 0, top: 40, right: 100, bottom: 60 } };
    const found = await scroll.findElementInHierarchy({ text: "Target" }, {
      hierarchy: {
        node: {
          "content-desc": "Unrelated row label",
          clickable: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          node: [target],
        },
      },
    } as any);
    expect(found?.bounds).toEqual(target.bounds);
  });
  test("text lookFor preserves curly-quote matching source geometry", async () => {
    const scroll = new ScrollUntilVisible({} as any);
    const target = { text: "It’s here", bounds: { left: 0, top: 40, right: 100, bottom: 60 } };
    const found = await scroll.findElementInHierarchy({ text: "It's here" }, {
      hierarchy: {
        node: {
          clickable: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          node: [target],
        },
      },
    } as any);
    expect(found?.bounds).toEqual(target.bounds);
  });
});

test("lookFor treats a temporarily missing container as a miss and retries within its scope", async () => {
  const scroll = new ScrollUntilVisible({} as any);
  const target = {
    "resource-id": "com.app:id/login",
    bounds: { left: 0, top: 0, right: 100, bottom: 40 },
  };
  const scope = { elementId: "panel" };
  expect(
    await scroll.findElementInHierarchy(
      { elementId: "login" },
      {
        hierarchy: { node: target },
      } as any,
      scope,
    ),
  ).toBeNull();
  const found = await scroll.findElementInHierarchy(
    { elementId: "login" },
    {
      hierarchy: {
        node: {
          "resource-id": "com.app:id/panel",
          bounds: { left: 0, top: 0, right: 200, bottom: 200 },
          node: [target],
        },
      },
    } as any,
    scope,
  );
  expect(found?.["resource-id"]).toBe("com.app:id/login");
});

describe("iOS chrome scroll-end guard", () => {
  for (const includeSystemInsets of [true, false]) {
    test(`does not label an unchanged navigation-bar swipe as end (includeSystemInsets=${includeSystemInsets})`, async () => {
      const fixture = loadIosRemindersNoiseObservePair().after;
      const observation = { ...fixture, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const finder = new FakeElementFinder();
      finder.nextScrollableContainer = { bounds: { left: 0, top: 0, right: 393, bottom: 852 } };
      const executor = new FakeTalkBackSwipeExecutor();
      const geometry = new FakeElementGeometry();
      geometry.swipeResult = { startX: 196, startY: 85, endX: 196, endY: 766 };
      const scroll = makeScrollUntilVisible({
        device: { ...DEVICE, platform: "ios" },
        geometry: includeSystemInsets ? new DefaultElementGeometry() : geometry,
        accessibilityDetector: new FakeAccessibilityDetector(),
        finder,
        timer,
        accessibilityService: new FakeScrollAccessibilityService(),
        observeResults: [observation],
        talkBackExecutor: executor,
      });
      await expect(
        scroll.execute({
          direction: "down",
          includeSystemInsets,
          lookFor: { text: "General", maxTime: 5000 },
        }),
      ).rejects.toThrow("swipe started in the navigation bar");
      expect(executor.getCallCount()).toBe(1);
    });
  }
  test("uses chrome-free bounds for screen fallback and reverse recovery", async () => {
    const fixture = loadIosRemindersNoiseObservePair().after;
    const observation = { ...fixture, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const executor = new FakeTalkBackSwipeExecutor();
    const scroll = makeScrollUntilVisible({
      device: { ...DEVICE, platform: "ios" },
      geometry: new DefaultElementGeometry(),
      accessibilityDetector: new FakeAccessibilityDetector(),
      finder: new FakeElementFinder(),
      timer,
      accessibilityService: new FakeScrollAccessibilityService(),
      observeResults: [observation],
      talkBackExecutor: executor,
    });
    await expect(
      scroll.execute({ direction: "down", lookFor: { text: "General", maxTime: 5000 } }),
    ).rejects.toThrow("Scroll reached end of container");
    const swipes = executor.getSwipeCalls();
    expect(swipes).toHaveLength(2);
    for (const swipe of swipes) {
      expect(swipe.y1).toBeGreaterThanOrEqual(104);
      expect(swipe.y1).toBeLessThanOrEqual(772);
      expect(swipe.y2).toBeGreaterThanOrEqual(104);
      expect(swipe.y2).toBeLessThanOrEqual(772);
    }
  });
});
