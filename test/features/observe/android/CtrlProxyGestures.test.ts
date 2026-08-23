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
    getWebSocket: () =>
      ({
        send: (data: string) => {
          sent.push(data);
        },
        readyState: 1,
      }) as any,
    requestManager,
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {
      /* no-op */
    },
    ...overrides,
  };
  return { context, sent, timer, requestManager };
}

/**
 * Let the async ensureConnected/sendCommand chain flush so the request is registered + sent.
 * A single setImmediate hop is a settle signal for the purely microtask-based chain: the event
 * loop drains the entire pending microtask queue (however many awaits sendCommand grows) before
 * running the immediate callback, so this stays robust against await-count changes (#3049).
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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
    requestManager.resolve<A11ySwipeResult>(sentMsg.requestId as string, {
      success: true,
      totalTimeMs: 1,
    });
    await promise;
  });

  it("rounds coordinates identically to the shared base gesture path (#3049)", async () => {
    // The two-finger override must reuse SharedGestureDelegate.coord() — the single Android
    // rounding source — so its wire coordinates can never diverge from the sibling gestures.
    const { context, sent, requestManager } = createFakeContext();
    const gestures = new CtrlProxyGestures(context);
    const coords = [10.5, 20.49, -3.5, 40.999] as const;

    const swipePromise = gestures.requestSwipe(...coords, 300, 5000);
    await flush();
    const swipeMsg = JSON.parse(sent[sent.length - 1]);

    const twoFingerPromise = gestures.requestTwoFingerSwipe(...coords, 300, 100, 5000);
    await flush();
    const twoFingerMsg = JSON.parse(sent[sent.length - 1]);

    expect(twoFingerMsg.type).toBe("request_two_finger_swipe");
    expect(swipeMsg.type).toBe("request_swipe");
    for (const key of ["x1", "y1", "x2", "y2"] as const) {
      expect(twoFingerMsg[key]).toBe(swipeMsg[key]);
      expect(Number.isInteger(twoFingerMsg[key])).toBe(true);
    }

    // Resolve both so no pending request dangles.
    requestManager.resolve(swipeMsg.requestId as string, { success: true, totalTimeMs: 1 });
    requestManager.resolve(twoFingerMsg.requestId as string, { success: true, totalTimeMs: 1 });
    await Promise.all([swipePromise, twoFingerPromise]);
    expect(requestManager.getPendingCount()).toBe(0);
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

  it("resolves two overlapping swipes independently with no cross-talk (#3048)", async () => {
    // The pre-#2988 bug was a single shared `pendingSwipeRequestId` field that could only
    // track one in-flight swipe. RequestManager.generateId is a monotonic counter, so each
    // request id is unique — assert two overlapping calls settle on their own promises,
    // even when their results arrive out of order.
    const { context, sent, timer, requestManager } = createFakeContext();
    const gestures = new CtrlProxyGestures(context);

    const promiseA = gestures.requestTwoFingerSwipe(1, 2, 3, 4, 300, 100, 5000);
    await flush();
    const idA = JSON.parse(sent[sent.length - 1]).requestId as string;

    const promiseB = gestures.requestTwoFingerSwipe(10, 20, 30, 40, 300, 100, 5000);
    await flush();
    const idB = JSON.parse(sent[sent.length - 1]).requestId as string;

    // Two distinct in-flight requests, distinct ids.
    expect(idA).not.toBe(idB);
    expect(requestManager.getPendingCount()).toBe(2);

    // Resolve out of order: B first, then A, with distinguishable payloads.
    expect(requestManager.resolve<A11ySwipeResult>(idB, { success: true, totalTimeMs: 222 })).toBe(
      true,
    );
    expect(requestManager.resolve<A11ySwipeResult>(idA, { success: true, totalTimeMs: 111 })).toBe(
      true,
    );

    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
    // Each promise settled with ITS OWN result — no cross-talk.
    expect(resultA.totalTimeMs).toBe(111);
    expect(resultB.totalTimeMs).toBe(222);
    expect(timer.getCurrentTime()).toBe(0);
    expect(requestManager.getPendingCount()).toBe(0);
  });

  it('fails promptly on a type:"error" frame via resolveError (#3048, #2985)', async () => {
    // A runner-side failure can arrive as a structured error envelope (#2985), which the client
    // routes through RequestManager.resolveError by requestId. Because two-finger swipes now
    // register with RequestManager, resolveError must correlate and settle the pending promise
    // before the timeout, leaving no dangling request.
    const { context, sent, timer, requestManager } = createFakeContext();
    const gestures = new CtrlProxyGestures(context);

    const promise = gestures.requestTwoFingerSwipe(0, 0, 100, 100, 300, 100, 5000);
    await flush();

    const id = JSON.parse(sent[sent.length - 1]).requestId as string;
    expect(requestManager.getPendingCount()).toBe(1);

    // Deliver a structured error frame BEFORE any timer advance.
    const handled = requestManager.resolveError(id, "Runner rejected two-finger swipe", 7);
    expect(handled).toBe(true);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("Runner rejected two-finger swipe");
    expect(result.totalTimeMs).toBe(7);
    // Settled by the error frame, not the timeout, and nothing left pending.
    expect(timer.getCurrentTime()).toBe(0);
    expect(requestManager.getPendingCount()).toBe(0);
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
