import { FakeDisplayTransitionReader } from "../../../fakes/FakeDisplayTransitionReader";
import { staleDisplayError } from "../../../../src/models/StaleDisplayError";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { describe, it, expect, spyOn } from "bun:test";
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

describe("Android gesture duration wire", () => {
  it.each([
    [250.5, 251],
    [250, 250],
    [0.1, 1],
    [0, 0],
  ] as const)(
    "normalizes %s to %s through the actual shared send path",
    async (duration, expected) => {
      const { context, sent, requestManager } = createFakeContext();
      const gestures = new CtrlProxyGestures(context);
      const requests = [
        () => gestures.requestTapCoordinates(10, 20, duration),
        () => gestures.requestSwipe(10, 20, 30, 40, duration),
        () => gestures.requestTwoFingerSwipe(10, 20, 30, 40, duration),
        () => gestures.requestDrag(10, 20, 30, 40, duration, duration, duration, 5000),
        () => gestures.requestPinch(10, 20, 30, 40, 15.5, duration),
      ];
      for (const send of requests) {
        const promise = send();
        await flush();
        const message = JSON.parse(sent[sent.length - 1]!);
        const fields =
          message.type === "request_drag"
            ? ["pressDurationMs", "dragDurationMs", "holdDurationMs"]
            : ["duration"];
        requestManager.resolve(message.requestId, { success: true, totalTimeMs: 0 });
        await promise;
        for (const field of fields) {
          expect(message[field]).toBe(expected);
        }
        if (message.type === "request_pinch") {
          expect(message.rotationDegrees).toBe(15.5);
        }
        expect(message).not.toHaveProperty("timeoutMs");
      }
    },
  );
});

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
    expect(swipeMsg).not.toHaveProperty("timeoutMs");
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

describe("gesture displayId wire compatibility", () => {
  const cases = [
    {
      name: "tap",
      legacy:
        '{"type":"request_tap_coordinates","requestId":"request","x":10,"y":20,"duration":10}',
      send: (g: CtrlProxyGestures, id?: number) =>
        g.requestTapCoordinates(10, 20, 10, 5000, undefined, undefined, undefined, undefined, id),
    },
    {
      name: "long press",
      legacy:
        '{"type":"request_tap_coordinates","requestId":"request","x":10,"y":20,"duration":800}',
      send: (g: CtrlProxyGestures, id?: number) =>
        g.requestTapCoordinates(10, 20, 800, 5000, undefined, undefined, undefined, undefined, id),
    },
    {
      name: "swipe",
      legacy:
        '{"type":"request_swipe","requestId":"request","x1":10,"y1":20,"x2":30,"y2":40,"duration":300}',
      send: (g: CtrlProxyGestures, id?: number) =>
        g.requestSwipe(10, 20, 30, 40, 300, 5000, undefined, undefined, undefined, undefined, id),
    },
    {
      name: "two-finger swipe",
      legacy:
        '{"type":"request_two_finger_swipe","requestId":"request","x1":10,"y1":20,"x2":30,"y2":40,"duration":300,"offset":100}',
      send: (g: CtrlProxyGestures, id?: number) =>
        g.requestTwoFingerSwipe(10, 20, 30, 40, 300, 100, 5000, undefined, id),
    },
    {
      name: "drag",
      legacy:
        '{"type":"request_drag","requestId":"request","x1":10,"y1":20,"x2":30,"y2":40,"pressDurationMs":600,"dragDurationMs":300,"holdDurationMs":100}',
      send: (g: CtrlProxyGestures, id?: number) =>
        g.requestDrag(10, 20, 30, 40, 600, 300, 100, 5000, undefined, undefined, id),
    },
    {
      name: "pinch",
      legacy:
        '{"type":"request_pinch","requestId":"request","centerX":10,"centerY":20,"distanceStart":30,"distanceEnd":40,"rotationDegrees":0,"duration":300}',
      send: (g: CtrlProxyGestures, id?: number) =>
        g.requestPinch(10, 20, 30, 40, 0, 300, 5000, undefined, undefined, id),
    },
    {
      name: "gesture start",
      legacy:
        '{"type":"request_gesture_start","requestId":"request","gestureId":"finger","x":10,"y":20}',
      send: (g: CtrlProxyGestures, id?: number) =>
        g.requestGestureStart("finger", 10, 20, 5000, undefined, id),
    },
  ];
  for (const { name, send } of cases) {
    it(`${name}: reconnect losing the display capability never dispatches`, async () => {
      let supported = true;
      const { context, sent, requestManager } = createFakeContext({
        getSupportedCommands: async () => ["gesture_display_id_v1"],
        isCommandSupported: (name) => name !== "gesture_display_id_v1" || supported,
        ensureConnected: async () => {
          supported = false;
          return true;
        },
      });
      const pending = send(new CtrlProxyGestures(context), 2);
      await flush();
      expect(sent).toEqual([]);
      expect((await pending).success).toBe(false);
      expect(requestManager.getPendingCount()).toBe(0);
    });
  }
  for (const { name, send, legacy } of cases) {
    for (const supported of [false, true]) {
      it(`${name}: flag ${supported} gates only the non-default display field`, async () => {
        const { context, sent, requestManager } = createFakeContext({
          getSupportedCommands: async () => (supported ? ["gesture_display_id_v1"] : []),
          isCommandSupported: (name) => name !== "gesture_display_id_v1" || supported,
        });
        const gestures = new CtrlProxyGestures(context);
        const wires: string[] = [];
        for (const id of [undefined, 0, 2]) {
          const pending = send(gestures, id);
          await flush();
          if (id === 2 && !supported) {
            expect(sent).toHaveLength(2);
            expect((await pending).success).toBe(false);
            expect(requestManager.getPendingCount()).toBe(0);
            continue;
          }
          const raw = sent.at(-1)!;
          const message = JSON.parse(raw) as { requestId: string; displayId?: number };
          expect(message.displayId).toBe(supported && id === 2 ? 2 : undefined);
          wires.push(raw.replace(message.requestId, "request"));
          requestManager.resolve(message.requestId, {
            success: false,
            totalTimeMs: 0,
            error: "Invalid display 2",
          });
          expect((await pending).error).toBe("Invalid display 2");
        }
        expect(wires[0]).toBe(legacy);
        expect(wires[1]).toBe(wires[0]);
        if (supported) {
          expect(wires[2]).toBe(wires[0].slice(0, -1) + ',"displayId":2}');
        }
        expect(sent).toHaveLength(supported ? 3 : 2);
      });
    }
  }
});

describe("Android client forwards gesture displayId", () => {
  it("forwards swipe displayId and abort signal independently", async () => {
    const { context, sent, requestManager, timer } = createFakeContext({
      getSupportedCommands: async () => ["gesture_display_id_v1"],
      isCommandSupported: () => true,
    });
    const client = AndroidCtrlProxyClient.createForTesting(
      { deviceId: "client-swipe-cancel", platform: "android", name: "Fake" },
      new FakeAdbExecutor(),
      undefined,
      timer,
    );
    client["_gestures"] = new CtrlProxyGestures(context);
    const controller = new AbortController();
    const pending = client.requestSwipe(
      1,
      2,
      3,
      4,
      300,
      5000,
      undefined,
      undefined,
      undefined,
      controller.signal,
      2,
    );
    await flush();

    const message = JSON.parse(sent.at(-1)!) as { type: string; displayId: number };
    expect(message.type).toBe("request_swipe");
    expect(message.displayId).toBe(2);
    expect(requestManager.getPendingCount()).toBe(1);

    controller.abort(new Error("swipe caller cancelled"));
    expect(requestManager.getPendingCount()).toBe(0);
    await expect(pending).rejects.toThrow("swipe caller cancelled");
    expect(sent).toHaveLength(1);
    expect(timer.getCurrentTime()).toBe(0);
  });

  const cases = [
    {
      name: "tap",
      send: (c: AndroidCtrlProxyClient) =>
        c.requestTapCoordinates(1, 2, 10, 5000, undefined, undefined, undefined, undefined, 2),
    },
    {
      name: "long press",
      send: (c: AndroidCtrlProxyClient) =>
        c.requestTapCoordinates(1, 2, 800, 5000, undefined, undefined, undefined, undefined, 2),
    },
    {
      name: "swipe",
      send: (c: AndroidCtrlProxyClient) =>
        c.requestSwipe(1, 2, 3, 4, 300, 5000, undefined, undefined, undefined, undefined, 2),
    },
    {
      name: "two-finger swipe",
      send: (c: AndroidCtrlProxyClient) =>
        c.requestTwoFingerSwipe(1, 2, 3, 4, 300, 100, 5000, undefined, 2),
    },
    {
      name: "drag",
      send: (c: AndroidCtrlProxyClient) =>
        c.requestDrag(1, 2, 3, 4, 600, 300, 100, 5000, undefined, undefined, 2),
    },
    {
      name: "pinch",
      send: (c: AndroidCtrlProxyClient) =>
        c.requestPinch(1, 2, 3, 4, 0, 300, 5000, undefined, undefined, 2),
    },
    {
      name: "gesture start",
      send: (c: AndroidCtrlProxyClient) =>
        c.requestGestureStart("finger", 1, 2, 5000, undefined, 2),
    },
  ];
  for (const { name, send } of cases) {
    it(name, async () => {
      const { context, sent, requestManager, timer } = createFakeContext({
        getSupportedCommands: async () => ["gesture_display_id_v1"],
        isCommandSupported: () => true,
      });
      const client = AndroidCtrlProxyClient.createForTesting(
        { deviceId: "client-forward", platform: "android", name: "Fake" },
        new FakeAdbExecutor(),
        undefined,
        timer,
      );
      client["_gestures"] = new CtrlProxyGestures(context);
      const pending = send(client);
      await flush();
      const message = JSON.parse(sent.at(-1)!) as { requestId: string; displayId: number };
      expect(message.displayId).toBe(2);
      requestManager.resolve(message.requestId, { success: true, totalTimeMs: 0 });
      expect((await pending).success).toBe(true);
      expect(sent).toHaveLength(1);
    });
  }
});

describe("Android display gesture cancellation", () => {
  const cases = [
    {
      name: "tap",
      send: (c: AndroidCtrlProxyClient, signal: AbortSignal) =>
        c.requestTapCoordinates(1, 2, 10, 5000, undefined, undefined, undefined, signal, 2),
    },
    {
      name: "drag",
      send: (c: AndroidCtrlProxyClient, signal: AbortSignal) =>
        c.requestDrag(1, 2, 3, 4, 600, 300, 100, 5000, undefined, signal, 2),
    },
    {
      name: "pinch",
      send: (c: AndroidCtrlProxyClient, signal: AbortSignal) =>
        c.requestPinch(1, 2, 30, 40, 0, 300, 5000, undefined, signal, 2),
    },
  ];
  for (const { name, send } of cases) {
    for (const phase of ["connecting", "response"] as const) {
      it(`${name} forwards cancellation while awaiting ${phase}`, async () => {
        const controller = new AbortController();
        const { context, sent, requestManager, timer } = createFakeContext({
          getSupportedCommands: async () => ["gesture_display_id_v1"],
          isCommandSupported: () => true,
          ensureConnected: async () => {
            if (phase === "connecting") {
              controller.abort(new Error("caller cancelled"));
            }
            return true;
          },
        });
        const client = AndroidCtrlProxyClient.createForTesting(
          { deviceId: `cancel-${name}-${phase}`, platform: "android", name: "Fake" },
          new FakeAdbExecutor(),
          undefined,
          timer,
        );
        client["_gestures"] = new CtrlProxyGestures(context);
        const pending = send(client, controller.signal);
        await flush();
        if (phase === "connecting") {
          expect(sent).toEqual([]);
          expect((await pending).success).toBe(false);
        } else {
          expect(sent).toHaveLength(1);
          controller.abort(new Error("caller cancelled"));
          expect(requestManager.getPendingCount()).toBe(0);
          await expect(pending).rejects.toThrow("caller cancelled");
        }
        expect(requestManager.getPendingCount()).toBe(0);
        expect(timer.getCurrentTime()).toBe(0);
      });
    }
  }
});

describe("gesture pre-send display fence during reconnect", () => {
  const cases = [
    {
      name: "tap",
      send: (c: AndroidCtrlProxyClient, guard: () => void, signal?: AbortSignal) =>
        c.requestTapCoordinates(1, 2, 10, 5000, undefined, undefined, undefined, signal, 2, guard),
    },
    {
      name: "swipe",
      send: (c: AndroidCtrlProxyClient, guard: () => void, signal?: AbortSignal) =>
        c.requestSwipe(1, 2, 3, 4, 300, 5000, undefined, undefined, undefined, signal, 2, guard),
    },
    {
      name: "drag",
      send: (c: AndroidCtrlProxyClient, guard: () => void, signal?: AbortSignal) =>
        c.requestDrag(1, 2, 3, 4, 600, 300, 100, 5000, undefined, signal, 2, guard),
    },
    {
      name: "pinch",
      send: (c: AndroidCtrlProxyClient, guard: () => void, signal?: AbortSignal) =>
        c.requestPinch(1, 2, 30, 40, 0, 300, 5000, undefined, signal, 2, guard),
    },
    {
      name: "two-finger swipe",
      send: (c: AndroidCtrlProxyClient, guard: () => void) =>
        c.requestTwoFingerSwipe(1, 2, 3, 4, 300, 100, 5000, undefined, 2, guard),
    },
    {
      name: "gesture start",
      send: (c: AndroidCtrlProxyClient, guard: () => void) =>
        c.requestGestureStart("finger", 1, 2, 5000, undefined, 2, guard),
    },
  ];
  for (const { name, send } of cases) {
    for (const phase of ["transition", "unchanged", "abort"] as const) {
      if (phase === "abort" && (name === "two-finger swipe" || name === "gesture start")) {
        continue;
      }
      it(`${name}: ${phase} while ensureConnected is pending`, async () => {
        const connecting = Promise.withResolvers<boolean>();
        const transitions = new FakeDisplayTransitionReader();
        const initialGeneration = transitions.generation;
        const stale = staleDisplayError(initialGeneration, initialGeneration + 1, "cover");
        const guard = spyOn(
          {
            check: () => {
              if (transitions.generation !== initialGeneration) {
                throw stale;
              }
            },
          },
          "check",
        );
        const { context, sent, requestManager, timer } = createFakeContext({
          ensureConnected: () => connecting.promise,
          isCommandSupported: () => true,
        });
        const client = AndroidCtrlProxyClient.createForTesting(
          { deviceId: `pre-send-${name}-${phase}`, platform: "android", name: "Fake" },
          new FakeAdbExecutor(),
          undefined,
          timer,
        );
        client["_gestures"] = new CtrlProxyGestures(context);
        const controller = new AbortController();
        const add = spyOn(controller.signal, "addEventListener");
        const remove = spyOn(controller.signal, "removeEventListener");
        const pending = send(client, guard, controller.signal).then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        );
        await flush();
        expect(sent).toHaveLength(0);
        if (phase === "transition") {
          transitions.transition();
        }
        if (phase === "abort") {
          controller.abort(new Error("Operation cancelled"));
        }
        connecting.resolve(true);
        await flush();
        // Settle the unfixed implementation too, so failures never leave pending timers.
        for (const id of requestManager.getPendingIds()) {
          requestManager.resolve(id, { success: true, totalTimeMs: 0 });
        }
        const outcome = await pending;
        expect(requestManager.getPendingCount()).toBe(0);
        expect(timer.getPendingTimeoutCount()).toBe(0);
        expect(remove.mock.calls.length).toBe(add.mock.calls.length);
        if (phase === "transition") {
          expect(sent).toHaveLength(0);
          expect(outcome.error).toBe(stale);
          expect(guard).toHaveBeenCalledTimes(1);
        } else if (phase === "abort") {
          expect(sent).toHaveLength(0);
          expect(outcome.result?.success).toBe(false);
          expect(outcome.result?.error).toBe("Request aborted before dispatch");
        } else {
          expect(sent).toHaveLength(1);
          expect(outcome.result?.success).toBe(true);
          expect(guard).toHaveBeenCalledTimes(1);
        }
        add.mockRestore();
        remove.mockRestore();
        guard.mockRestore();
      });
    }
  }
});

it("tap cancellation inside the pre-send guard prevents dispatch and cleans registration", async () => {
  const { context, sent, requestManager, timer } = createFakeContext({
    isCommandSupported: () => true,
  });
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "cancel-at-send", platform: "android", name: "Fake" },
    new FakeAdbExecutor(),
    undefined,
    timer,
  );
  client["_gestures"] = new CtrlProxyGestures(context);
  const controller = new AbortController();
  const reason = new Error("Operation cancelled at send");
  const pending = client
    .requestTapCoordinates(
      1,
      2,
      10,
      5000,
      undefined,
      undefined,
      undefined,
      controller.signal,
      2,
      () => controller.abort(reason),
    )
    .then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
  await flush();
  for (const id of requestManager.getPendingIds()) {
    requestManager.resolve(id, { success: true, totalTimeMs: 0 });
  }
  const outcome = await pending;
  expect(sent).toHaveLength(0);
  expect(outcome.error).toBe(reason);
  expect(requestManager.getPendingCount()).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
