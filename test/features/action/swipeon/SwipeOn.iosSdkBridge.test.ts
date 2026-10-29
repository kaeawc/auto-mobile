import { afterEach, expect, mock, test } from "bun:test";
import { IosSdkBridgeSwipeRunner } from "../../../../src/features/action/IosSdkBridgeSwipeRouter";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import type { IosSdkAction } from "../../../../src/features/observe/ios/sdkObservationBridge";
import type { CtrlProxySdkActionResult } from "../../../../src/features/observe/ios/types";
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

const feedBounds = { left: 0, top: 200, right: 1080, bottom: 1700 };

/** An iOS screen whose app merged a scrollable bridge list at the given capture. */
function screen(identity: number, row: string): ObserveResult {
  return {
    updatedAt: identity,
    observationId: `capture-${identity}`,
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
              attrs: {
                "resource-id": "feed",
                scrollable: true,
                class: "List",
                "sdk-element-id": "feed",
                "sdk-capture-identity": String(identity),
              },
              bounds: feedBounds,
              children: [
                {
                  attrs: { text: row },
                  bounds: { ...feedBounds, bottom: feedBounds.top + 100 },
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

class FakeActionClient {
  actions: IosSdkAction[] = [];
  constructor(private readonly reply: CtrlProxySdkActionResult) {}
  async requestSdkActionForIos(action: IosSdkAction): Promise<CtrlProxySdkActionResult> {
    this.actions.push(action);
    return this.reply;
  }
}

function harness(reply: CtrlProxySdkActionResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const client = new FakeActionClient(reply);
  const xctest = new FakeTalkBackSwipeExecutor();
  const observe = new FakeObserveScreen();
  observe.setObserveResult(() =>
    screen(41 + client.actions.length, `row ${client.actions.length}`),
  );
  const action = new SwipeOn(
    { name: "fake", platform: "ios", deviceId: "ios-sdk-swipe" },
    new FakeAdbClient(),
    {
      timer,
      observeScreen: observe,
      executeGesture: new FakeGestureExecutor(),
      voiceOverExecutor: new IosSdkBridgeSwipeRunner(xctest, {
        client: () => client,
        enabled: () => true,
      }),
      accessibilityDetector: new FakeAccessibilityDetector(),
    },
  );
  action.awaitIdle = new FakeAwaitIdle();
  action.window = new FakeWindow();
  return { action, client, xctest };
}

const accepted: CtrlProxySdkActionResult = {
  success: true,
  available: true,
  result: { status: "accepted", durationMs: 3, nextObservationIdentity: 42 },
  totalTimeMs: 4,
};

test("swipeOn on a bridge list scrolls through the bridge and reports backend sdk (#5159)", async () => {
  const h = harness(accepted);
  const result = await h.action.execute({ direction: "up", container: { elementId: "feed" } });
  expect(result).toMatchObject({ success: true, backend: "sdk", targetType: "element" });
  expect(h.client.actions).toHaveLength(1);
  const scroll = (h.client.actions[0] as { scroll: { elementId: string; delta: { y: number } } })
    .scroll;
  expect(scroll.elementId).toBe("feed");
  // Swiping up moves content down the list: the content offset grows.
  expect(scroll.delta.y).toBeGreaterThan(0);
  expect(h.xctest.getCallCount()).toBe(0);
});

test("swipeOn without auto-targeting swipes the bridge screen through the bridge (#5159)", async () => {
  const h = harness(accepted);
  const result = await h.action.execute({ direction: "up", autoTarget: false });
  expect(result).toMatchObject({ success: true, backend: "sdk", targetType: "screen" });
  expect(Object.keys(h.client.actions[0])).toEqual(["swipe"]);
  expect(h.xctest.getCallCount()).toBe(0);
});

test("an unsupported bridge scroll is swiped by XCTest and says why (#5159)", async () => {
  const h = harness({
    success: false,
    available: true,
    result: { status: "rejected", reason: "unsupported_action", durationMs: 0 },
    totalTimeMs: 1,
  });
  const result = await h.action.execute({ direction: "up", container: { elementId: "feed" } });
  expect(result).toMatchObject({ backend: "xctest", fallbackReason: "unsupported" });
  expect(h.xctest.getCallCount()).toBe(1);
});
