import { afterEach, describe, expect, mock, test } from "bun:test";
import type { IosSdkTapOutcome } from "../../../../src/features/action/IosSdkBridgeTapRouter";
import type { IosSdkWebScrollIntoView } from "../../../../src/features/action/swipeon/IosSdkWebScrollIntoView";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import type { ObserveResult } from "../../../../src/models";
import { encodeIosDollar } from "../../../fixtures/hierarchyArbitraries";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeAwaitIdle } from "../../../fakes/FakeAwaitIdle";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWindow } from "../../../fakes/FakeWindow";

afterEach(() => mock.restore());

const pageBounds = { left: 0, top: 200, right: 1080, bottom: 1700 };

/** An iOS screen showing one web view; `Pay` is in view only once `payVisible`. */
function screen(serial: number, payVisible: boolean): ObserveResult {
  const row = payVisible ? "Pay" : `Intro ${serial}`;
  return {
    updatedAt: serial,
    observationId: `capture-${serial}`,
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    freshness: { isFresh: true },
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    viewHierarchy: {
      hierarchy: {
        node: encodeIosDollar({
          attrs: { class: "XCUIElementTypeApplication" },
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          children: [
            {
              attrs: { class: "WKWebView", scrollable: true, "resource-id": "page" },
              bounds: pageBounds,
              children: [
                {
                  attrs: { text: row },
                  bounds: { ...pageBounds, top: 800, bottom: 900 },
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

class FakeWebScroller implements IosSdkWebScrollIntoView {
  requests: Array<{ text?: string; elementId?: string }> = [];
  scrolled = false;
  constructor(private readonly outcome: IosSdkTapOutcome | null) {}
  async scroll(lookFor: { text?: string; elementId?: string }): Promise<IosSdkTapOutcome | null> {
    this.requests.push(lookFor);
    this.scrolled = this.outcome?.backend === "sdk";
    return this.outcome;
  }
}

function harness(outcome: IosSdkTapOutcome | null) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const web = new FakeWebScroller(outcome);
  const xctest = new FakeTalkBackSwipeExecutor();
  const observe = new FakeObserveScreen();
  let serial = 0;
  // An XCTest swipe also brings Pay into view, so the fallback search ends after one swipe.
  observe.setObserveResult(() => screen(++serial, web.scrolled || xctest.getCallCount() > 0));
  const action = new SwipeOn(
    { name: "fake", platform: "ios", deviceId: "ios-web-scroll" },
    new FakeAdbClient(),
    {
      timer,
      observeScreen: observe,
      executeGesture: new FakeGestureExecutor(),
      voiceOverExecutor: xctest,
      webScrollIntoView: web,
      accessibilityDetector: new FakeAccessibilityDetector(),
    },
  );
  action.awaitIdle = new FakeAwaitIdle();
  action.window = new FakeWindow();
  return { action, web, xctest };
}

describe("swipeOn lookFor a web-view DOM element (#5162)", () => {
  test("the page scrolls the element into view, with no swipe, and reports backend sdk", async () => {
    const h = harness({ backend: "sdk" });
    const result = await h.action.execute({ direction: "up", lookFor: { text: "Pay" } });
    expect(result).toMatchObject({
      success: true,
      found: true,
      backend: "sdk",
      scrollIterations: 0,
    });
    expect(h.web.requests).toEqual([{ text: "Pay" }]);
    expect(h.xctest.getCallCount()).toBe(0);
  });

  test("an unavailable bridge swipes with XCTest and says why", async () => {
    const h = harness({ backend: "xctest", fallbackReason: "unavailable" });
    const result = await h.action.execute({ direction: "up", lookFor: { text: "Pay" } });
    expect(result).toMatchObject({
      success: true,
      found: true,
      backend: "xctest",
      fallbackReason: "unavailable",
    });
    expect(h.xctest.getCallCount()).toBeGreaterThan(0);
  });

  test("a target that is no page element swipes as before and reports no backend", async () => {
    const h = harness(null);
    const result = await h.action.execute({ direction: "up", lookFor: { text: "Pay" } });
    expect(result).toMatchObject({ success: true, found: true });
    expect(result.backend).toBeUndefined();
    expect(h.xctest.getCallCount()).toBeGreaterThan(0);
  });

  test("a target already in view is found without asking the page", async () => {
    const h = harness({ backend: "sdk" });
    h.xctest.getCallCount = () => 1;
    const result = await h.action.execute({ direction: "up", lookFor: { text: "Pay" } });
    expect(result).toMatchObject({ success: true, found: true, scrollIterations: 0 });
    expect(h.web.requests).toEqual([]);
  });

  test("a search scoped to a container or a layer never asks the page", async () => {
    for (const scope of [{ container: { elementId: "page" } }, { layer: "app" as const }]) {
      const h = harness({ backend: "sdk" });
      await h.action
        .execute({ direction: "up", lookFor: { text: "Pay" }, ...scope })
        .catch(() => {});
      expect(h.web.requests).toEqual([]);
    }
  });
});
