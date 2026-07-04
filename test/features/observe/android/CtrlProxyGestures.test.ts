import { describe, it, expect } from "bun:test";
import { CtrlProxyGestures } from "../../../../src/features/observe/android/CtrlProxyGestures";
import type { DelegateContext } from "../../../../src/features/observe/shared/types";
import type { A11ySwipeResult } from "../../../../src/features/observe/android/types";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { RequestManager } from "../../../../src/utils/RequestManager";

/**
 * Tests for the Android two-finger swipe result correlation (#2988).
 *
 * The two-finger swipe must resolve from the real `swipe_result` frame the runner returns
 * (routed through RequestManager, exactly like the sibling swipe/tap/drag/pinch gestures),
 * NOT only via its timeout.
 */
function createFakeContext(overrides?: Partial<DelegateContext>): {
  context: DelegateContext;
  sent: string[];
  timer: FakeTimer;
  requestManager: RequestManager;
} {
  const timer = new FakeTimer();
  const requestManager = new RequestManager(timer);
  const sent: string[] = [];
  const context: DelegateContext = {
    getWebSocket: () => ({
      send: (data: string) => { sent.push(data); },
      readyState: 1,
    } as any),
    requestManager,
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => { /* no-op */ },
    ...overrides,
  };
  return { context, sent, timer, requestManager };
}

/** Let the async ensureConnected chain flush so the request is registered + sent. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("CtrlProxyGestures.requestTwoFingerSwipe (#2988)", () => {
  it("resolves from a swipe_result frame before the timeout fires (success)", async () => {
    const { context, sent, timer, requestManager } = createFakeContext();
    const gestures = new CtrlProxyGestures(context);

    const promise = gestures.requestTwoFingerSwipe(10, 20, 30, 40, 300, 100, 5000);
    await flush();

    // The request must have been registered with RequestManager (not sent raw).
    expect(requestManager.getPendingCount()).toBe(1);
    const sentMsg = JSON.parse(sent[sent.length - 1]);
    expect(sentMsg.requestId).toBeDefined();
    expect(String(sentMsg.requestId).startsWith("two_finger_swipe_")).toBe(true);

    // Deliver the runner's swipe_result BEFORE any timer advance.
    const resolved = requestManager.resolve<A11ySwipeResult>(sentMsg.requestId as string, {
      success: true,
      totalTimeMs: 123,
      gestureTimeMs: 100,
    });
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.totalTimeMs).toBe(123);
    // Timer never advanced → resolution did not come from the timeout.
    expect(timer.getCurrentTime()).toBe(0);
    // No dangling pending request nor timeout left behind.
    expect(requestManager.getPendingCount()).toBe(0);
  });

  it("propagates a runner-reported failure promptly (no timeout wait)", async () => {
    const { context, sent, timer, requestManager } = createFakeContext();
    const gestures = new CtrlProxyGestures(context);

    const promise = gestures.requestTwoFingerSwipe(1, 2, 3, 4, 300, 100, 5000);
    await flush();

    const sentMsg = JSON.parse(sent[sent.length - 1]);
    requestManager.resolve<A11ySwipeResult>(sentMsg.requestId as string, {
      success: false,
      totalTimeMs: 5,
      error: "Non-finite coordinate rejected",
    });

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("Non-finite coordinate rejected");
    expect(timer.getCurrentTime()).toBe(0);
  });

  it("sends the correct wire message with rounded coordinates and offset", async () => {
    const { context, sent, requestManager } = createFakeContext();
    const gestures = new CtrlProxyGestures(context);

    const promise = gestures.requestTwoFingerSwipe(10.7, 20.3, 30.4, 40.9, 250, 80, 5000);
    await flush();

    const sentMsg = JSON.parse(sent[sent.length - 1]);
    expect(sentMsg.type).toBe("request_two_finger_swipe");
    expect(sentMsg.x1).toBe(11);
    expect(sentMsg.y1).toBe(20);
    expect(sentMsg.x2).toBe(30);
    expect(sentMsg.y2).toBe(41);
    expect(sentMsg.duration).toBe(250);
    expect(sentMsg.offset).toBe(80);

    // Resolve so the promise settles (avoid a dangling pending request).
    requestManager.resolve<A11ySwipeResult>(sentMsg.requestId as string, { success: true, totalTimeMs: 1 });
    await promise;
  });

  it("still times out when the runner never replies", async () => {
    const { context, timer } = createFakeContext();
    const gestures = new CtrlProxyGestures(context);

    const promise = gestures.requestTwoFingerSwipe(0, 0, 100, 100, 300, 100, 100);
    await flush();

    timer.advanceTime(101);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("returns Not connected without sending when the connection cannot be established", async () => {
    const { context, sent } = createFakeContext({ ensureConnected: async () => false });
    const gestures = new CtrlProxyGestures(context);

    const result = await gestures.requestTwoFingerSwipe(0, 0, 100, 100);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Not connected");
    expect(sent.length).toBe(0);
  });
});
