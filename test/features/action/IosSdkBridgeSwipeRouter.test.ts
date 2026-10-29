import { describe, expect, test } from "bun:test";
import {
  IosSdkBridgeSwipeRunner,
  iosSdkBridgeSwipeTimeoutMs,
} from "../../../src/features/action/IosSdkBridgeSwipeRouter";
import type {
  SwipeGestureRequest,
  VoiceOverSwipeRunner,
} from "../../../src/features/action/swipeon/types";
import type { IosSdkAction } from "../../../src/features/observe/ios/sdkObservationBridge";
import type { CtrlProxySdkActionResult } from "../../../src/features/observe/ios/types";
import type { Element } from "../../../src/models";
import type { SwipeResult } from "../../../src/models/SwipeResult";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

const bounds = { left: 0, top: 100, right: 400, bottom: 900 };
const bridgeList: Element = {
  bounds,
  class: "List",
  "sdk-element-id": "feed",
  "sdk-capture-identity": "41",
};
const xctestList: Element = { bounds, class: "XCUIElementTypeScrollView" };

/** A screen whose app merged one bridge node at capture 41. */
const bridgeScreen: { viewHierarchy: ViewHierarchyResult } = {
  viewHierarchy: {
    hierarchy: {
      node: {
        $: { class: "XCUIElementTypeApplication" },
        node: [{ $: { class: "List", "sdk-element-id": "feed", "sdk-capture-identity": "41" } }],
      },
    },
  },
};
const xctestScreen: { viewHierarchy: ViewHierarchyResult } = {
  viewHierarchy: { hierarchy: { node: { $: { class: "XCUIElementTypeApplication" } } } },
};

class FakeXctestRunner implements VoiceOverSwipeRunner {
  requests: SwipeGestureRequest[] = [];
  async executeSwipeGesture(request: SwipeGestureRequest): Promise<SwipeResult> {
    this.requests.push(request);
    const { x1, y1, x2, y2 } = request;
    return { success: true, x1, y1, x2, y2, duration: 300, effectiveDurationMs: 300 };
  }
}

class FakeActionClient {
  actions: IosSdkAction[] = [];
  timeouts: Array<number | undefined> = [];
  constructor(private readonly reply: CtrlProxySdkActionResult) {}
  async requestSdkActionForIos(
    action: IosSdkAction,
    options?: { timeoutMs?: number },
  ): Promise<CtrlProxySdkActionResult> {
    this.actions.push(action);
    this.timeouts.push(options?.timeoutMs);
    return this.reply;
  }
}

const accepted: CtrlProxySdkActionResult = {
  success: true,
  available: true,
  result: { status: "accepted", durationMs: 3, nextObservationIdentity: 42 },
  totalTimeMs: 4,
};

function rejected(reason: string): CtrlProxySdkActionResult {
  return {
    success: false,
    available: true,
    result: { status: "rejected", reason, durationMs: 0 },
    error: reason,
    totalTimeMs: 1,
  };
}

function runner(reply: CtrlProxySdkActionResult = accepted, enabled = true) {
  const xctest = new FakeXctestRunner();
  const client = new FakeActionClient(reply);
  const swipe = new IosSdkBridgeSwipeRunner(xctest, {
    client: () => client,
    enabled: () => enabled,
  });
  return { xctest, client, swipe };
}

function request(overrides: Partial<SwipeGestureRequest> = {}): SwipeGestureRequest {
  return {
    x1: 200,
    y1: 800,
    x2: 200,
    y2: 200,
    direction: "up",
    containerElement: null,
    gestureOptions: { duration: 300 },
    ...overrides,
  };
}

describe("IosSdkBridgeSwipeRunner (#5159)", () => {
  test("a bridge container scrolls by the content-offset change, opposite to the finger", async () => {
    const { xctest, client, swipe } = runner();
    const result = await swipe.executeSwipeGesture(
      request({ containerElement: bridgeList, sdkObservation: bridgeScreen }),
    );
    expect(result).toMatchObject({ success: true, backend: "sdk", x1: 200, y2: 200 });
    expect(client.actions).toEqual([
      { scroll: { observationIdentity: 41, elementId: "feed", delta: { x: 0, y: 600 } } },
    ]);
    expect(xctest.requests).toEqual([]);
  });

  test("a screen swipe on a bridge screen goes through the bridge swipe with the same points", async () => {
    const { xctest, client, swipe } = runner();
    const result = await swipe.executeSwipeGesture(
      request({ sdkObservation: bridgeScreen, gestureOptions: { duration: 4000 } }),
    );
    expect(result).toMatchObject({ success: true, backend: "sdk", duration: 4000 });
    expect(client.actions).toEqual([
      {
        swipe: {
          observationIdentity: 41,
          start: { x: 200, y: 800 },
          end: { x: 200, y: 200 },
          durationMs: 4000,
        },
      },
    ]);
    expect(client.timeouts).toEqual([7000]);
    expect(xctest.requests).toEqual([]);
  });

  test("edge swipes, XCTest containers and XCTest-only screens stay on XCTest silently", async () => {
    const { xctest, client, swipe } = runner();
    const edge = await swipe.executeSwipeGesture(request());
    const xctestContainer = await swipe.executeSwipeGesture(
      request({ containerElement: xctestList, sdkObservation: bridgeScreen }),
    );
    const plainScreen = await swipe.executeSwipeGesture(request({ sdkObservation: xctestScreen }));
    for (const result of [edge, xctestContainer, plainScreen]) {
      expect(result.backend).toBeUndefined();
      expect(result.fallbackReason).toBeUndefined();
    }
    expect(xctest.requests).toHaveLength(3);
    expect(client.actions).toEqual([]);
  });

  test("the container's identity comes from the capture the swipe was resolved against", async () => {
    const { client, swipe } = runner();
    const staleContainer = { ...bridgeList, "sdk-capture-identity": "7" };
    await swipe.executeSwipeGesture(
      request({ containerElement: staleContainer, sdkObservation: bridgeScreen }),
    );
    expect(client.actions).toEqual([
      { scroll: { observationIdentity: 41, elementId: "feed", delta: { x: 0, y: 600 } } },
    ]);
  });

  test("a scroll search passes no observation, so its bridge container stays on XCTest", async () => {
    const { xctest, client, swipe } = runner();
    const result = await swipe.executeSwipeGesture(request({ containerElement: bridgeList }));
    expect(result.backend).toBeUndefined();
    expect(xctest.requests).toHaveLength(1);
    expect(client.actions).toEqual([]);
  });

  test("routing off passes every swipe to XCTest", async () => {
    const { xctest, client, swipe } = runner(accepted, false);
    await swipe.executeSwipeGesture(
      request({ containerElement: bridgeList, sdkObservation: bridgeScreen }),
    );
    expect(xctest.requests).toHaveLength(1);
    expect(client.actions).toEqual([]);
  });

  test("a boomerang has no bridge form: XCTest runs it and reports unsupported", async () => {
    const { xctest, client, swipe } = runner();
    const result = await swipe.executeSwipeGesture(
      request({
        containerElement: bridgeList,
        sdkObservation: bridgeScreen,
        boomerang: { apexPauseMs: 0, returnSpeed: 1 },
      }),
    );
    expect(result).toMatchObject({ backend: "xctest", fallbackReason: "unsupported" });
    expect(xctest.requests).toHaveLength(1);
    expect(client.actions).toEqual([]);
  });

  test("XCTest stands in for an unsupported action or an unavailable bridge", async () => {
    const unsupported = runner(rejected("unsupported_action"));
    expect(
      await unsupported.swipe.executeSwipeGesture(request({ sdkObservation: bridgeScreen })),
    ).toMatchObject({ backend: "xctest", fallbackReason: "unsupported", effectiveDurationMs: 300 });
    expect(unsupported.xctest.requests).toHaveLength(1);

    const unavailable = runner({
      success: false,
      available: false,
      failure: "bridge_unavailable",
      totalTimeMs: 1,
    });
    expect(
      await unavailable.swipe.executeSwipeGesture(
        request({ containerElement: bridgeList, sdkObservation: bridgeScreen }),
      ),
    ).toMatchObject({ backend: "xctest", fallbackReason: "unavailable" });
  });

  test("a stale or unknown target fails closed without an XCTest swipe", async () => {
    const stale = runner(rejected("stale_observation"));
    await expect(
      stale.swipe.executeSwipeGesture(request({ sdkObservation: bridgeScreen })),
    ).rejects.toThrow("rejected the swipe (stale_observation)");
    expect(stale.xctest.requests).toEqual([]);

    const unknown = runner(rejected("unknown_element"));
    await expect(
      unknown.swipe.executeSwipeGesture(
        request({ containerElement: bridgeList, sdkObservation: bridgeScreen }),
      ),
    ).rejects.toThrow("rejected the scroll (unknown_element)");
    expect(unknown.xctest.requests).toEqual([]);
  });

  test("the bridge budget covers the gesture plus headroom", () => {
    expect(iosSdkBridgeSwipeTimeoutMs(300)).toBe(5000);
    expect(iosSdkBridgeSwipeTimeoutMs(10000)).toBe(13000);
  });
});
