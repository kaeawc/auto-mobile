import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import {
  TapAnyElement,
  TAP_ANY_LONG_PRESS_MAX_DURATION_MS,
} from "../../../src/features/action/TapAnyElement";
import type { BootedDevice, Element, ObserveResult } from "../../../src/models";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { DefaultIosVoiceOverDetector } from "../../../src/utils/IosVoiceOverDetector";
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
    fakeWindow.configureCachedActiveWindow(null);

    const iosModule = await import("../../../src/features/observe/ios");
    getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeIosClient as any,
    );

    tapAny = new TapAnyElement(IOS_DEVICE, new FakeAdbClient() as any, {
      timer: fakeTimer,
      elementSelector: fakeElementSelector,
      iosVoiceOverDetector: fakeVoiceOverDetector,
    });
    (tapAny as any).observeScreen = fakeObserveScreen;
    (tapAny as any).awaitIdle = fakeAwaitIdle;
    (tapAny as any).window = fakeWindow;
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    getInstanceSpy = null;
  });

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
    fakeIosClient.setTapResult({ success: false, error: "boom", totalTimeMs: 1 });

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
      { label: "Target Button", action: "activate" },
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
      { label: "Target Button", action: "activate" },
    ]);
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
  });

  test("VoiceOver enabled + longPress routes through requestVoiceOverActivate with long_press", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);

    const result = await tapAny.execute({ action: "longPress", duration: 1500 });

    expect(result.success).toBe(true);
    expect(fakeIosClient.getVoiceOverActivateHistory()).toEqual([
      { label: "Target Button", action: "long_press" },
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
      { label: "Target Button", action: "activate" },
    ]);
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
  });

  // Thread PRRT_kwDOP-GF5M6ftbHR: CtrlProxy blocks its reply until the on-device
  // press completes, so a >5s long press must size the request timeout from the
  // press duration — requestTapCoordinates otherwise defaults to a fixed 5s
  // timeout that fires (and reports failure) before a longer press finishes.
  test("longPress over 5s sizes the requestTapCoordinates timeout from the duration", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(false);
    const tapSpy = spyOn(fakeIosClient, "requestTapCoordinates");

    const result = await tapAny.execute({ action: "longPress", duration: 6000 });

    expect(result.success).toBe(true);
    expect(tapSpy).toHaveBeenCalledWith(42, 84, 6000, 8000);
  });

  // Thread PRRT_kwDOP-GF5M6fuZRt (#6248 review, terminal round): an earlier
  // round merely CLAMPED the inner/outer timers while still forwarding the
  // full absurd `duration` to XCTest -- a clamp-vs-duration mismatch that
  // asked the on-device press to run far longer than the request would wait.
  // `getLongPressDuration` now REJECTS a duration whose derived request
  // deadline would exceed `MAX_SETTIMEOUT_DELAY_MS` outright, closing the
  // whole absurd-duration edge class at the source instead of clamping.
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
    expect(tapSpy).toHaveBeenCalledWith(42, 84, duration, duration + 2000);
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
    expect(activateSpy).toHaveBeenCalledWith("Target Button", "long_press", duration + 2000);
  });

  test("VoiceOver longPress over 5s sizes the requestVoiceOverActivate timeout from the duration", async () => {
    fakeVoiceOverDetector.setVoiceOverEnabled(true);
    const activateSpy = spyOn(fakeIosClient, "requestVoiceOverActivate");

    const result = await tapAny.execute({ action: "longPress", duration: 6000 });

    expect(result.success).toBe(true);
    expect(activateSpy).toHaveBeenCalledWith("Target Button", "long_press", 8000);
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
    // timeout is sized from that same normalized value (1501 + 2000 headroom).
    expect(tapSpy).toHaveBeenCalledWith(42, 84, 1501, 3501);
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
    // timeout is sized from that same floored value (1 + 2000 headroom).
    expect(tapSpy).toHaveBeenCalledWith(42, 84, 1, 2001);
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
      undefined,
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
      undefined,
    );
    expect(fakeIosClient.getActionHistory()).toEqual([
      { action: "activate", resourceId: "com.test.app:id/submit_button", label: undefined },
    ]);
    expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(0);
    expect(fakeIosClient.getTapHistory()).toHaveLength(0);
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
