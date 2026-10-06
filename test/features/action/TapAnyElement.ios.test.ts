import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../../../src/features/observe/shared/SharedGestureDelegate";
import { afterEach, beforeEach, describe, expect, test, spyOn, mock } from "bun:test";
import {
  TapAnyElement,
  TAP_ANY_LONG_PRESS_MAX_DURATION_MS,
  TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
} from "../../../src/features/action/TapAnyElement";
import type { BootedDevice, Element, ObserveResult } from "../../../src/models";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { DefaultIosVoiceOverDetector } from "../../../src/features/accessibility/IosVoiceOverDetector";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../fakes/FakeWindow";

// Regression coverage for #6248: the iOS branch of TapAnyElement previously called
// tap/doubleTap/longPress on IOSCtrlProxyClient, none of which exist (TS2339,
// tolerated in scripts/typecheck-baseline.txt) — every iOS tapAny action failed
// in ~5ms with "D.tap is not a function". The real gesture API is
// requestTapCoordinates, which TapOnElement already uses successfully.
//
// These tests drive the PUBLIC `TapAnyElement.execute(...)` entry point (not a
// private helper) with the existing FakeElementSelector/FakeObserveScreen test
// doubles, so a revert of the iOS switch in `execute()` back to the broken
// tap/doubleTap/longPress calls fails the suite end-to-end, rather than leaving
// it green because only a still-correct private helper was exercised directly.
const IOS_DEVICE: BootedDevice = {
  deviceId: "00001234-ABCD",
  platform: "ios",
  name: "test-iphone",
} as any;

const makeClickableElement = (): Element =>
  ({
    bounds: { left: 0, top: 0, right: 84, bottom: 168 },
    text: "Target",
    "content-desc": "Target Button",
    "ios-accessibility-label": "Target Button",
    clickable: "true",
  }) as Element;

const createObserveResult = (): ObserveResult => ({
  updatedAt: Date.now(),
  screenSize: { width: 390, height: 844 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy: {
    hierarchy: { node: {} },
    packageName: "com.test.app",
    updatedAt: Date.now(),
  },
});

describe("TapAnyElement iOS gesture dispatch (public execute())", () => {
  let fakeIosClient: FakeIOSCtrlProxy;
  let fakeVoiceOverDetector: FakeIosVoiceOverDetector;
  let fakeElementSelector: FakeElementSelector;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeWindow: FakeWindow;
  let fakeTimer: FakeTimer;
  let tapAny: TapAnyElement;
  let displayLookup: ReturnType<typeof mock<() => undefined>>;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(async () => {
    fakeIosClient = new FakeIOSCtrlProxy();
    fakeVoiceOverDetector = new FakeIosVoiceOverDetector();
    fakeElementSelector = new FakeElementSelector(makeClickableElement());
    fakeObserveScreen = new FakeObserveScreen();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeWindow = new FakeWindow();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    fakeObserveScreen.setObserveResult(() => createObserveResult());
    // Gesture tests start with this call's observer read; cached-resolution safety
    // is covered separately with a real selector and a configured hierarchy fake.
    spyOn(fakeObserveScreen, "getMostRecentCachedObserveResult").mockImplementation(async () => ({
      ...createObserveResult(),
      freshness: { isFresh: false },
    }));
    fakeWindow.configureCachedActiveWindow(null);

    const iosModule = await import("../../../src/features/observe/ios");
    getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeIosClient as any,
    );

    displayLookup = mock(() => undefined);
    tapAny = new TapAnyElement(IOS_DEVICE, new FakeAdbClient() as any, {
      timer: fakeTimer,
      elementSelector: fakeElementSelector,
      iosVoiceOverDetector: fakeVoiceOverDetector,
      lastRenderedObservation: displayLookup,
    });
    (tapAny as any).observeScreen = fakeObserveScreen;
    (tapAny as any).awaitIdle = fakeAwaitIdle;
    (tapAny as any).window = fakeWindow;
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    getInstanceSpy = null;
  });

  test.each([false, true])(
    "budget admission dispatches 17000 ms on iOS (VoiceOver=%s)",
    async (voiceOver) => {
      fakeVoiceOverDetector.setVoiceOverEnabled(voiceOver);
      const tap = spyOn(fakeIosClient, "requestTapCoordinates");
      const activate = spyOn(fakeIosClient, "requestVoiceOverActivate");
      const result = await tapAny.execute(
        { action: "longPress", duration: 17000 },
        undefined,
        undefined,
        { requestDeadlineMs: fakeTimer.now() + 120000 },
      );
      expect(result.success).toBe(true);
      if (voiceOver) {
        expect(activate).toHaveBeenCalledWith("Target Button", "long_press", 19000, undefined, {
          bounds: makeClickableElement().bounds,
          duration: 17000,
        });
        expect(tap).not.toHaveBeenCalled();
      } else {
        expect(tap).toHaveBeenCalledWith(
          42,
          84,
          17000,
          19000,
          undefined,
          undefined,
          undefined,
          expect.any(Function),
        );
        expect(activate).not.toHaveBeenCalled();
      }
    },
  );

  test.each([
    [false, 61000, 5000],
    [false, 60000.5, 5000],
    [false, Infinity, 5000],
    [false, 20000, 5000],
    [false, 20000, 21999],
    [true, 61000, 5000],
    [true, 60000.5, 5000],
    [true, Infinity, 5000],
    [true, 20000, 5000],
    [true, 20000, 21999],
  ] as const)(
    "budget admission returns failure without iOS observation or dispatch (VoiceOver=%s, duration=%s, remaining=%s)",
    async (voiceOver, duration, remaining) => {
      fakeVoiceOverDetector.setVoiceOverEnabled(voiceOver);
      const tap = spyOn(fakeIosClient, "requestTapCoordinates");
      const activate = spyOn(fakeIosClient, "requestVoiceOverActivate");
      const observe = spyOn(fakeObserveScreen, "execute");
      const interaction = spyOn(tapAny, "observedInteraction");
      const result = await tapAny.execute(
        { action: "longPress", duration, display: "1" },
        undefined,
        undefined,
        { requestDeadlineMs: fakeTimer.now() + remaining },
      );
      expect(result.success).toBe(false);
      expect(result.action).toBe("longPress");
      expect(result.element.bounds).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
      expect(result.error).toStartWith("Failed to tap clickable element: ");
      expect(result.error).toContain(
        duration === 20000
          ? `longPress duration 20000 ms does not fit the remaining request budget (${remaining} ms; needs 22000 ms including dispatch headroom); the press was not started.`
          : `maximum is 60000 ms; requested ${duration} ms`,
      );
      expect(tap).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
      expect(interaction).not.toHaveBeenCalled();
      expect(displayLookup).not.toHaveBeenCalled();
    },
  );

  test("tap dispatches a single requestTapCoordinates call at the element's center", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(true);
    expect(fakeIosClient.getTapHistory()).toEqual([{ x: 42, y: 84, duration: 50 }]);
    // Never call the non-existent methods from the original bug.
    expect((fakeIosClient as any).tap).toBeUndefined();
    expect((fakeIosClient as any).doubleTap).toBeUndefined();
    expect((fakeIosClient as any).longPress).toBeUndefined();
  });

  test("doubleTap dispatches two requestTapCoordinates calls at the element's center", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);

    const result = await tapAny.execute({ action: "doubleTap" });

    expect(result.success).toBe(true);
    expect(fakeIosClient.getTapHistory()).toEqual([
      { x: 42, y: 84, duration: 50 },
      { x: 42, y: 84, duration: 50 },
    ]);
  });

  test("longPress dispatches one requestTapCoordinates call with the long-press duration", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);

    const result = await tapAny.execute({ action: "longPress", duration: 1500 });

    expect(result.success).toBe(true);
    expect(fakeIosClient.getTapHistory()).toEqual([{ x: 42, y: 84, duration: 1500 }]);
  });

  test("tap reports failure when the proxy reports failure", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    // An explicit runner refusal: dispatched and acknowledged, so a plain failure.
    fakeIosClient.setTapResult({
      success: false,
      error: "boom",
      totalTimeMs: 1,
      dispatched: true,
      acknowledged: true,
    });

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("CtrlProxy iOS tap failed: boom");
  });

  // Thread PRRT_kwDOP-GF5M6ftbHQ: a bare coordinate press only FOCUSES an element
  // under VoiceOver, it does not ACTIVATE it. When VoiceOver is enabled, tapAny
  // must route through requestVoiceOverActivate instead — mirroring
  // TapOnElement.executeiOSTap's VoiceOver-detection + activation path.
  test("VoiceOver enabled + tap routes through requestVoiceOverActivate, not a coordinate tap", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(true);
    expect(fakeIosClient.getVoiceOverActivateHistory()).toEqual([
      {
        label: "Target Button",
        action: "activate",
        bounds: makeClickableElement().bounds,
        duration: undefined,
      },
    ]);
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
  });

  // #6267 follow-up (P1 regression fix): an indeterminate probe must still
  // route the real DefaultIosVoiceOverDetector -> isVoiceOverActiveOrUnknown
  // -> tap-bias path, not the honest isVoiceOverEnabled a toggle/query
  // consumer would use. Wires the real detector (not the boolean-only Fake)
  // against a CtrlProxy client whose requestVoiceOverState throws, so this
  // exercises the actual fail-safe bias rather than a hand-set boolean.
  test("VoiceOver probe indeterminate (CtrlProxy failure) + tap still routes through requestVoiceOverActivate", async () => {
    const realDetector = new DefaultIosVoiceOverDetector(fakeTimer);
    fakeIosClient.setFailureMode("voiceOverState", new Error("CtrlProxy timeout"));
    tapAny = new TapAnyElement(IOS_DEVICE, new FakeAdbClient() as any, {
      timer: fakeTimer,
      elementSelector: fakeElementSelector,
      iosVoiceOverDetector: realDetector,
    });
    (tapAny as any).observeScreen = fakeObserveScreen;
    (tapAny as any).awaitIdle = fakeAwaitIdle;
    (tapAny as any).window = fakeWindow;

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(true);
    expect(fakeIosClient.getVoiceOverActivateHistory()).toEqual([
      {
        label: "Target Button",
        action: "activate",
        bounds: makeClickableElement().bounds,
        duration: undefined,
      },
    ]);
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
  });

  test("VoiceOver enabled + longPress routes through requestVoiceOverActivate with long_press", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);

    const result = await tapAny.execute({ action: "longPress", duration: 1500 });

    expect(result.success).toBe(true);
    expect(fakeIosClient.getVoiceOverActivateHistory()).toEqual([
      {
        label: "Target Button",
        action: "long_press",
        bounds: makeClickableElement().bounds,
        duration: 1500,
      },
    ]);
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
  });

  // Thread PRRT_kwDOP-GF5M6ftlb7: under VoiceOver a bare coordinate press only
  // FOCUSES an element rather than activating it, so a coordinate-press
  // fallback after a failed VoiceOver activation would mask a real failure.
  // tapAny must propagate the activation failure instead of reporting success.
  test("VoiceOver enabled but VoiceOver action fails propagates the failure (does not fall back to a coordinate tap)", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    fakeIosClient.setVoiceOverActivateResult({ success: false, error: "no such label" });

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no such label");
    expect(fakeIosClient.getVoiceOverActivateHistory()).toEqual([
      {
        label: "Target Button",
        action: "activate",
        bounds: makeClickableElement().bounds,
        duration: undefined,
      },
    ]);
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
  });

  test.each(["abort", "timeout"])(
    "a dispatched iOS long press reports the held-pointer risk on %s",
    async (failure) => {
      fakeVoiceOverDetector.setVoiceOverEnabled(false);
      const controller = new AbortController();
      const request = spyOn(fakeIosClient, "requestTapCoordinates").mockImplementation(
        async (_x, _y, duration, _timeout, _perf, _frame, signal) => {
          expect(duration).toBe(1500);
          expect(signal).toBe(controller.signal);
          if (failure === "abort") {
            controller.abort();
            throw new DOMException("Operation aborted", "AbortError");
          }
          return { success: false, totalTimeMs: 3500, error: "Tap timed out after 3500ms" };
        },
      );
      try {
        const result = await tapAny.execute(
          { action: "longPress", duration: 1500 },
          undefined,
          controller.signal,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("press may still be held on the device for up to 1500 ms");
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        request.mockRestore();
      }
    },
  );

  // Thread PRRT_kwDOP-GF5M6ftbHR: CtrlProxy blocks its reply until the on-device
  // press completes, so a >5s long press must size the request timeout from the
  // press duration — requestTapCoordinates otherwise defaults to a fixed 5s
  // timeout that fires (and reports failure) before a longer press finishes.
  test("longPress over 5s sizes the requestTapCoordinates timeout from the duration", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    const tapSpy = spyOn(fakeIosClient, "requestTapCoordinates");

    const result = await tapAny.execute({ action: "longPress", duration: 6000 });

    expect(result.success).toBe(true);
    expect(tapSpy).toHaveBeenCalledWith(
      42,
      84,
      6000,
      8000,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
  });

  // Issue #6276 (follow-up to #6248 review thread funaf): an ordinary
  // tap/doubleTap previously passed `timeoutMs: undefined`, falling through
  // to `requestTapCoordinates`'s own generic default with no tapAny-specific
  // floor/ceiling. It must now size an explicit timeout from its fixed press
  // duration, the same way longPress does -- floored at
  // TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS (5000ms) so it never drops
  // BELOW the established default `requestTapCoordinates` already applied
  // (issue #6306 review, P1): the raw duration+headroom arithmetic alone
  // (50ms + 2000ms = 2050ms) would otherwise cut a legitimate 2.05-5s
  // CtrlProxy round trip short.
  test("tap sizes an explicit requestTapCoordinates timeout, floored at the established 5s default", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    const tapSpy = spyOn(fakeIosClient, "requestTapCoordinates");

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(true);
    expect(tapSpy).toHaveBeenCalledWith(
      42,
      84,
      50,
      TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
  });

  // Issue #6306 review (P1/P2): the outer MCP request signal previously never
  // reached the VoiceOver-detection probe or the coordinate-tap gesture, so a
  // caller deadline that expired while CtrlProxy was reconnecting could still
  // let the tap dispatch after the caller had already received a timeout.
  // `sendCommand` (invoked by both `requestVoiceOverState` and
  // `requestTapCoordinates`) enforces the actual abort-before-dispatch
  // behavior — see `SharedGestureDelegate.test.ts` and
  // `CtrlProxyVoiceOver.test.ts` for that mechanism's own regression
  // coverage; this test only verifies `execute()`'s `signal` reaches the
  // gesture call.
  test("threads the caller's abort signal into requestTapCoordinates", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    const tapSpy = spyOn(fakeIosClient, "requestTapCoordinates");
    const controller = new AbortController();

    const result = await tapAny.execute({ action: "tap" }, undefined, controller.signal);

    expect(result.success).toBe(true);
    const [, , , , , , signalArg] = tapSpy.mock.calls[0] ?? [];
    expect(signalArg).toBe(controller.signal);
  });

  test("threads the caller's abort signal into the VoiceOver-detection probe", async () => {
    const probeSpy = spyOn(fakeVoiceOverDetector, "isVoiceOverActiveOrUnknown");
    const controller = new AbortController();

    await tapAny.execute({ action: "tap" }, undefined, controller.signal);

    const [, , , , signalArg] = probeSpy.mock.calls[0] ?? [];
    expect(signalArg).toBe(controller.signal);
  });

  test("doubleTap sizes an explicit requestTapCoordinates timeout for both presses, floored at the established 5s default", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    const tapSpy = spyOn(fakeIosClient, "requestTapCoordinates");

    const result = await tapAny.execute({ action: "doubleTap" });

    expect(result.success).toBe(true);
    expect(tapSpy).toHaveBeenCalledTimes(2);
    expect(tapSpy).toHaveBeenNthCalledWith(
      1,
      42,
      84,
      50,
      TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
    expect(tapSpy).toHaveBeenNthCalledWith(
      2,
      42,
      84,
      50,
      TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
  });

  test("VoiceOver enabled + tap sizes an explicit requestVoiceOverActivate timeout, floored at the established 5s default", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    const activateSpy = spyOn(fakeIosClient, "requestVoiceOverActivate");

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(true);
    expect(activateSpy).toHaveBeenCalledWith(
      "Target Button",
      "activate",
      TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
      undefined,
      { bounds: makeClickableElement().bounds, duration: undefined },
    );
  });

  // Issue #6306 review, P2: the pre-tap search loop's per-iteration hierarchy
  // refresh must be constrained to the search loop's OWN remaining budget --
  // an unconstrained refresh could independently run for the full generic
  // default (`IOS_HIERARCHY_REQUEST_TIMEOUT_MS`, ~15s) regardless of how much
  // of `searchUntil.duration` is actually left, letting the outer MCP floor
  // expire mid-search even though this call would eventually have returned.
  test("search loop constrains each hierarchy refresh to its own remaining budget, not the client default", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    fakeIosClient.setHierarchyData({ packageName: "com.test.app", updatedAt: Date.now() });
    const hierarchyRequests = spyOn(fakeIosClient, "requestHierarchySync");
    // First selectClickable call (before the search loop) reports nothing
    // found; the fake element selector's default (call-through) behavior on
    // every later call keeps returning the configured clickable element, so
    // the search loop finds it on its first iteration.
    spyOn(fakeElementSelector, "selectClickable").mockImplementationOnce(() => ({
      element: null,
      indexInMatches: -1,
      totalMatches: 0,
      strategy: "first",
    }));

    const result = await tapAny.execute({
      action: "tap",
      searchUntil: { duration: 500 },
    });

    expect(result.success).toBe(true);
    const timeouts = hierarchyRequests.mock.calls.map((call) => call[3]);
    // At least one refresh happened during the search loop, and every one of
    // them was bounded to (at most) the search window -- never left
    // `undefined`, which is what let the old code fall through to
    // `getLatestHierarchy`'s own unconstrained default.
    expect(timeouts.length).toBeGreaterThan(0);
    for (const timeoutMs of timeouts) {
      expect(timeoutMs).toBeDefined();
      expect(timeoutMs as number).toBeGreaterThan(0);
      expect(timeoutMs as number).toBeLessThanOrEqual(500);
    }
  });

  test("does not tap a hierarchy refresh that returns at the search deadline", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    const hierarchy = createObserveResult().viewHierarchy;
    spyOn(fakeElementSelector, "selectClickable")
      .mockImplementationOnce(() => ({
        element: null,
        indexInMatches: -1,
        totalMatches: 0,
        strategy: "first",
      }))
      .mockImplementation(() => ({
        element: makeClickableElement(),
        indexInMatches: 0,
        totalMatches: 1,
        strategy: "first",
      }));
    (tapAny as any).refreshViewHierarchy = async () => {
      fakeTimer.advanceTime(400);
      return hierarchy;
    };

    const result = await tapAny.execute({ action: "tap", searchUntil: { duration: 500 } });

    expect(result.success).toBe(false);
    expect(fakeIosClient.getTapHistory()).toEqual([]);
  });

  // Thread PRRT_kwDOP-GF5M6fuZRt (#6248 review, terminal round): an earlier
  // round merely CLAMPED the inner/outer timers while still forwarding the
  // full absurd `duration` to XCTest -- a clamp-vs-duration mismatch that
  // asked the on-device press to run far longer than the request would wait.
  // `getLongPressDuration` now rejects above the shared 60000ms ceiling,
  // before the native press is dispatched, instead of clamping its timeout.
  test("longPress duration just over TAP_ANY_LONG_PRESS_MAX_DURATION_MS is REJECTED, not clamped-and-sent", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    const tapSpy = spyOn(fakeIosClient, "requestTapCoordinates");
    const duration = TAP_ANY_LONG_PRESS_MAX_DURATION_MS + 1;

    const result = await tapAny.execute({ action: "longPress", duration });
    expect(result.success).toBe(false);
    expect(result.error).toContain("longPress duration too large");
    expect(tapSpy).not.toHaveBeenCalled();
  });

  test("longPress duration at exactly TAP_ANY_LONG_PRESS_MAX_DURATION_MS is accepted", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    const tapSpy = spyOn(fakeIosClient, "requestTapCoordinates");
    const duration = TAP_ANY_LONG_PRESS_MAX_DURATION_MS;

    const result = await tapAny.execute({ action: "longPress", duration });

    expect(result.success).toBe(true);
    expect(tapSpy).toHaveBeenCalledWith(
      42,
      84,
      duration,
      duration + 2000,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
  });

  test("VoiceOver longPress duration just over TAP_ANY_LONG_PRESS_MAX_DURATION_MS is REJECTED, not clamped-and-sent", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    const activateSpy = spyOn(fakeIosClient, "requestVoiceOverActivate");
    const duration = TAP_ANY_LONG_PRESS_MAX_DURATION_MS + 1;

    const result = await tapAny.execute({ action: "longPress", duration });
    expect(result.success).toBe(false);
    expect(result.error).toContain("longPress duration too large");
    expect(activateSpy).not.toHaveBeenCalled();
  });

  test("VoiceOver longPress duration at exactly TAP_ANY_LONG_PRESS_MAX_DURATION_MS is accepted", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    const activateSpy = spyOn(fakeIosClient, "requestVoiceOverActivate");
    const duration = TAP_ANY_LONG_PRESS_MAX_DURATION_MS;

    const result = await tapAny.execute({ action: "longPress", duration });

    expect(result.success).toBe(true);
    expect(activateSpy).toHaveBeenCalledWith(
      "Target Button",
      "long_press",
      duration + 2000,
      undefined,
      {
        bounds: makeClickableElement().bounds,
        duration,
      },
    );
  });

  test("VoiceOver longPress over 5s sizes the requestVoiceOverActivate timeout from the duration", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    const activateSpy = spyOn(fakeIosClient, "requestVoiceOverActivate");

    const result = await tapAny.execute({ action: "longPress", duration: 6000 });

    expect(result.success).toBe(true);
    expect(activateSpy).toHaveBeenCalledWith("Target Button", "long_press", 8000, undefined, {
      bounds: makeClickableElement().bounds,
      duration: 6000,
    });
  });

  // Thread PRRT_kwDOP-GF5M6ftxl4: the public schema accepts a fractional longPress
  // duration and previously forwarded it unchanged, but CtrlProxy's
  // `RequestTapCoordinates.duration` (Swift Models.swift) is `Int?`, so Swift's
  // JSON decoder rejects a fractional value outright. The duration must be
  // normalized to an integer before it is used for BOTH the request payload and
  // the timeout sizing.
  test("longPress with a fractional duration forwards a normalized integer duration", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    const tapSpy = spyOn(fakeIosClient, "requestTapCoordinates");

    const result = await tapAny.execute({ action: "longPress", duration: 1500.5 });

    expect(result.success).toBe(true);
    // Normalized to 1501ms — used verbatim for the request payload, and the
    // timeout preserves the default while covering that normalized press.
    expect(tapSpy).toHaveBeenCalledWith(
      42,
      84,
      1501,
      DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
    expect(fakeIosClient.getTapHistory()).toEqual([{ x: 42, y: 84, duration: 1501 }]);
  });

  // Thread PRRT_kwDOP-GF5M6fuHzW: a positive sub-1ms-rounded longPress duration
  // (e.g. 0.4) must never normalize to 0 -- CtrlProxy's `GesturePerformer` treats
  // a non-positive `duration` as a plain tap (`coordinate.tap()`), silently
  // downgrading a requested long press into a tap that reports success instead
  // of performing a genuine (if very short) long press.
  test("longPress with a sub-1ms duration floors to 1ms instead of becoming a tap", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    const tapSpy = spyOn(fakeIosClient, "requestTapCoordinates");

    const result = await tapAny.execute({ action: "longPress", duration: 0.4 });

    expect(result.success).toBe(true);
    // Floored to 1ms — still a long press (duration > 0), not a tap — and the
    // timeout preserves the default while covering that floored press.
    expect(tapSpy).toHaveBeenCalledWith(
      42,
      84,
      1,
      DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
    expect(fakeIosClient.getTapHistory()).toEqual([{ x: 42, y: 84, duration: 1 }]);
  });

  // Thread PRRT_kwDOP-GF5M6ftxl6: under VoiceOver, a coordinate press only
  // FOCUSES an element — it does not activate it. When the selected clickable has
  // a resource-id but no label/content-desc/text, tapAny must activate it through
  // the identifier-based node-action path (`requestAction`) instead of doing a
  // single coordinate press and reporting success.
  test("VoiceOver enabled + resource-id-only target activates via requestAction, not a coordinate tap", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    fakeElementSelector.setNextElement({
      bounds: { left: 0, top: 0, right: 84, bottom: 168 },
      "resource-id": "com.test.app:id/submit_button",
      clickable: "true",
    } as Element);
    const actionSpy = spyOn(fakeIosClient, "requestAction");

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(true);
    expect(actionSpy).toHaveBeenCalledWith(
      "activate",
      "com.test.app:id/submit_button",
      undefined,
      TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
      undefined,
      { abortSignal: undefined, onDispatch: expect.any(Function) },
    );
    expect(fakeIosClient.getActionHistory()).toEqual([
      { action: "activate", resourceId: "com.test.app:id/submit_button", label: undefined },
    ]);
    expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(0);
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
  });

  test("VoiceOver enabled + resource-id-only target propagates a requestAction failure (no coordinate fallback)", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    fakeElementSelector.setNextElement({
      bounds: { left: 0, top: 0, right: 84, bottom: 168 },
      "resource-id": "com.test.app:id/submit_button",
      clickable: "true",
    } as Element);
    fakeIosClient.setActionResult({ success: false, error: "element not found" });

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("element not found");
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
  });

  describe("a dispatched but unconfirmed tap is indeterminate (#9971)", () => {
    const resourceIdElement = {
      bounds: { left: 0, top: 0, right: 84, bottom: 168 },
      "resource-id": "com.test.app:id/submit_button",
      clickable: "true",
    } as Element;
    const unconfirmed = {
      success: false,
      error: "Timeout waiting for action_result",
      dispatched: true,
      acknowledged: false,
    };

    test("requestAction (resource-id) under VoiceOver", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      fakeElementSelector.setNextElement(resourceIdElement);
      fakeIosClient.setActionResult(unconfirmed);

      const result = await tapAny.execute({ action: "tap" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Tap outcome is indeterminate");
      expect(result.error).toContain("Do not retry automatically");
    });

    test("requestAction acknowledged refusal stays a plain failure", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      fakeElementSelector.setNextElement(resourceIdElement);
      fakeIosClient.setActionResult({
        success: false,
        error: "element not found",
        dispatched: true,
        acknowledged: true,
      });

      const result = await tapAny.execute({ action: "tap" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("VoiceOver action failed");
      expect(result.error).not.toContain("indeterminate");
    });

    test("requestAction that was never dispatched stays a plain failure", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      fakeElementSelector.setNextElement(resourceIdElement);
      fakeIosClient.setActionResult({
        success: false,
        error: "Not connected to CtrlProxy",
        dispatched: false,
        acknowledged: false,
      });

      const result = await tapAny.execute({ action: "tap" });

      expect(result.error).toContain("VoiceOver action failed");
      expect(result.error).not.toContain("indeterminate");
    });

    test("requestAction receives the request's signal and a dispatch marker", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      fakeElementSelector.setNextElement(resourceIdElement);
      const actionSpy = spyOn(fakeIosClient, "requestAction");
      const controller = new AbortController();

      await tapAny.execute({ action: "tap" }, undefined, controller.signal);

      const options = actionSpy.mock.calls[0]?.[5];
      expect(options?.abortSignal).toBe(controller.signal);
      expect(typeof options?.onDispatch).toBe("function");
    });

    test("requestVoiceOverActivate by label", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      fakeIosClient.setVoiceOverActivateResult({
        success: false,
        error: "Timeout waiting for action_result",
        dispatched: true,
        acknowledged: false,
      });

      const result = await tapAny.execute({ action: "tap" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Tap outcome is indeterminate");
    });

    test("requestVoiceOverActivate acknowledged refusal stays a plain failure", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      fakeIosClient.setVoiceOverActivateResult({
        success: false,
        error: "Element not found",
        dispatched: true,
        acknowledged: true,
      });

      const result = await tapAny.execute({ action: "tap" });

      expect(result.error).toContain('VoiceOver action failed for label "Target Button"');
    });

    test("coordinate tap timeout", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(false);
      fakeIosClient.setTapResult({
        success: false,
        totalTimeMs: 5000,
        error: "Tap timed out after 5000ms",
        dispatched: true,
        acknowledged: false,
      });

      const result = await tapAny.execute({ action: "tap" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Tap outcome is indeterminate");
    });

    test("coordinate tap runner refusal stays plain", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(false);
      fakeIosClient.setTapResult({
        success: false,
        totalTimeMs: 10,
        error: "Element gone",
        dispatched: true,
        acknowledged: true,
      });

      const result = await tapAny.execute({ action: "tap" });

      expect(result.error).toContain("CtrlProxy iOS tap failed: Element gone");
    });

    test("an unconfirmed second tap of a double tap notes that one tap was delivered", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(false);
      let calls = 0;
      spyOn(fakeIosClient, "requestTapCoordinates").mockImplementation(async () => {
        calls++;
        return calls === 1
          ? { success: true, totalTimeMs: 1 }
          : {
              success: false,
              totalTimeMs: 5000,
              error: "Tap timed out after 5000ms",
              dispatched: true,
              acknowledged: false,
            };
      });

      const result = await tapAny.execute({ action: "doubleTap" });

      expect(result.error).toContain("Tap outcome is indeterminate");
      expect(result.error).toContain("one tap was delivered");
    });
  });

  // Thread PRRT_kwDOP-GF5M6funaa: when the selected element has BOTH a unique
  // resource-id AND a label shared by multiple controls, activating by label
  // alone is unsafe -- CtrlProxy resolves `requestVoiceOverActivate`'s label
  // via `.firstMatch`, a global (not container-scoped) query, so it could
  // activate a DIFFERENT same-labeled control than the one tapAny selected.
  // The resource-id must be preferred whenever it is usable.
  test("VoiceOver enabled + element has both a unique resource-id and a shared label activates via requestAction, not requestVoiceOverActivate", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    fakeElementSelector.setNextElement({
      bounds: { left: 0, top: 0, right: 84, bottom: 168 },
      "resource-id": "com.test.app:id/submit_button",
      "ios-accessibility-label": "Submit",
      clickable: "true",
    } as Element);
    const actionSpy = spyOn(fakeIosClient, "requestAction");

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(true);
    expect(actionSpy).toHaveBeenCalledWith(
      "activate",
      "com.test.app:id/submit_button",
      undefined,
      TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
      undefined,
      { abortSignal: undefined, onDispatch: expect.any(Function) },
    );
    expect(fakeIosClient.getActionHistory()).toEqual([
      { action: "activate", resourceId: "com.test.app:id/submit_button", label: undefined },
    ]);
    expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(0);
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
  });

  test("VoiceOver resource-id longPress forwards its requested duration", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    fakeElementSelector.setNextElement({
      bounds: { left: 0, top: 0, right: 84, bottom: 168 },
      "resource-id": "com.test.app:id/submit_button",
      clickable: "true",
    } as Element);
    const actionSpy = spyOn(fakeIosClient, "requestAction");

    const result = await tapAny.execute({ action: "longPress", duration: 1750 });

    expect(result.success).toBe(true);
    expect(actionSpy).toHaveBeenCalledWith(
      "long_press",
      "com.test.app:id/submit_button",
      undefined,
      DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
      undefined,
      { duration: 1750, abortSignal: undefined, onDispatch: expect.any(Function) },
    );
    expect(fakeIosClient.getActionHistory()[0]?.duration).toBe(1750);
  });

  test("VoiceOver enabled + no label and no resource-id fails fast instead of a focus-only coordinate press", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    fakeElementSelector.setNextElement({
      bounds: { left: 0, top: 0, right: 84, bottom: 168 },
      clickable: "true",
    } as Element);

    const result = await tapAny.execute({ action: "tap" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no accessibility label");
    expect(fakeIosClient.getActionHistory()).toHaveLength(0);
    expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(0);
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
  });
});
