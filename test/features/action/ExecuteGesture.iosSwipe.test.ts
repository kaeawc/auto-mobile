import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { CtrlProxyGestures } from "../../../src/features/observe/ios/CtrlProxyGestures";
import { ActionableError, type BootedDevice } from "../../../src/models";
import { StaleDisplayError } from "../../../src/features/observe/StaleDisplayError";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { createIosDelegateHarness } from "../../helpers/iosDelegateHarness";
import { spyOnIosClientInstance } from "../../helpers/iosCtrlProxyClientSpies";
import type { SwipeRequest } from "../../../src/utils/interfaces/SwipeRequest";

const device: BootedDevice = { deviceId: "ios-swipe", platform: "ios", name: "iPhone" };

type SwipeScript = (
  onDispatch: () => void,
) => Promise<Awaited<ReturnType<IOSCtrlProxyClient["requestSwipe"]>>>;

/** Records what ExecuteGesture hands the iOS client and plays a scripted transport outcome. */
class ScriptedSwipeClient extends FakeIOSCtrlProxy {
  receivedSignal: AbortSignal | undefined;
  receivedOnDispatch: (() => void) | undefined;
  calls = 0;

  constructor(private readonly script: SwipeScript) {
    super();
  }

  override async requestSwipe(
    request: SwipeRequest,
  ): ReturnType<IOSCtrlProxyClient["requestSwipe"]> {
    this.calls++;
    this.receivedSignal = request.signal;
    this.receivedOnDispatch = request.onDispatch;
    return this.script(() => request.onDispatch?.());
  }
}

let spy: ReturnType<typeof spyOn> | undefined;

function use(client: FakeIOSCtrlProxy): void {
  spy = spyOnIosClientInstance(client);
}

afterEach(() => {
  spy?.mockRestore();
  spy = undefined;
});

const timeoutText = "Swipe timed out after 5000ms";

describe("ExecuteGesture iOS single-finger swipe (#9972)", () => {
  test("a dispatched swipe whose reply times out is indeterminate, not a plain failure", async () => {
    use(
      new ScriptedSwipeClient(async (dispatch) => {
        dispatch();
        return { success: false, totalTimeMs: 5000, error: timeoutText };
      }),
    );

    const result = await new ExecuteGesture(device).swipe(
      { x1: 1, y1: 2, x2: 3, y2: 4 },
      { duration: 250 },
    );

    expect(result).toMatchObject({
      success: false,
      outcomeIndeterminate: true,
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
      duration: 250,
    });
    expect(result.error).toBe(
      `Swipe outcome is indeterminate: the request was dispatched but no result was confirmed (${timeoutText}). The swipe may have been applied. Do not retry automatically.`,
    );
  });

  test("the transport's dispatched-but-unacknowledged marker is indeterminate", async () => {
    use(
      new ScriptedSwipeClient(async () => ({
        success: false,
        totalTimeMs: 5000,
        error: timeoutText,
        dispatched: true,
        acknowledged: false,
        retryable: false,
      })),
    );

    const result = await new ExecuteGesture(device).swipe({ x1: 1, y1: 2, x2: 3, y2: 4 });

    expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
  });

  test("a socket close rejecting after dispatch is indeterminate instead of a throw", async () => {
    use(
      new ScriptedSwipeClient(async (dispatch) => {
        dispatch();
        throw new Error("WebSocket connection closed");
      }),
    );

    const result = await new ExecuteGesture(device).swipe({ x1: 1, y1: 2, x2: 3, y2: 4 });

    expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
    expect(result.error).toContain("WebSocket connection closed");
    expect(result.error).toContain("The swipe may have been applied. Do not retry automatically.");
  });

  test.each([
    [
      "not connected before dispatch",
      { success: false, totalTimeMs: 0, error: "Not connected", dispatched: false },
    ],
    [
      "a runner refusal reply",
      {
        success: false,
        totalTimeMs: 3,
        error: "runner refused",
        dispatched: true,
        acknowledged: true,
      },
    ],
  ] as const)("%s stays a plain failure", async (_name, reply) => {
    use(new ScriptedSwipeClient(async () => ({ ...reply })));

    const result = await new ExecuteGesture(device).swipe({ x1: 1, y1: 2, x2: 3, y2: 4 });

    expect(result.success).toBe(false);
    expect(result.error).toBe(reply.error);
    expect(result.outcomeIndeterminate).toBeUndefined();
  });

  test("a failure with no dispatch callback and no markers stays a plain failure", async () => {
    use(
      new ScriptedSwipeClient(async () => ({
        success: false,
        totalTimeMs: 0,
        error: "Not connected",
      })),
    );

    const result = await new ExecuteGesture(device).swipe({ x1: 1, y1: 2, x2: 3, y2: 4 });

    expect(result).toMatchObject({ success: false, error: "Not connected" });
    expect(result.outcomeIndeterminate).toBeUndefined();
  });

  test("a runner refusal thrown after dispatch keeps its own failure", async () => {
    const refusal = new ActionableError("runner_busy: retry shortly");
    use(
      new ScriptedSwipeClient(async (dispatch) => {
        dispatch();
        throw refusal;
      }),
    );

    await expect(new ExecuteGesture(device).swipe({ x1: 1, y1: 2, x2: 3, y2: 4 })).rejects.toBe(
      refusal,
    );
  });

  test("a stale display thrown after dispatch is not downgraded to indeterminate", async () => {
    const stale = new StaleDisplayError({
      observedGeneration: 1,
      currentGeneration: 2,
      retry: "observe",
    });
    use(
      new ScriptedSwipeClient(async (dispatch) => {
        dispatch();
        throw stale;
      }),
    );

    await expect(new ExecuteGesture(device).swipe({ x1: 1, y1: 2, x2: 3, y2: 4 })).rejects.toBe(
      stale,
    );
  });

  test("an error before dispatch propagates", async () => {
    use(
      new ScriptedSwipeClient(async () => {
        throw new Error("connect failed");
      }),
    );

    await expect(new ExecuteGesture(device).swipe({ x1: 1, y1: 2, x2: 3, y2: 4 })).rejects.toThrow(
      "connect failed",
    );
  });

  test("the caller's AbortSignal and a dispatch callback reach the request", async () => {
    const client = new ScriptedSwipeClient(async () => ({ success: true, totalTimeMs: 1 }));
    use(client);
    const controller = new AbortController();

    const result = await new ExecuteGesture(device).swipe(
      { x1: 1, y1: 2, x2: 3, y2: 4 },
      { duration: 100 },
      { signal: controller.signal },
    );

    expect(result.success).toBe(true);
    expect(client.receivedSignal).toBe(controller.signal);
    expect(typeof client.receivedOnDispatch).toBe("function");
  });

  test("a call cancelled before dispatch sends nothing", async () => {
    const client = new ScriptedSwipeClient(async () => ({ success: true, totalTimeMs: 1 }));
    use(client);
    const controller = new AbortController();
    controller.abort(new ActionableError("caller cancelled"));

    await expect(
      new ExecuteGesture(device).swipe(
        { x1: 1, y1: 2, x2: 3, y2: 4 },
        {},
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Operation cancelled");
    expect(client.calls).toBe(0);
  });

  test("a successful swipe keeps its timing result", async () => {
    use(
      new ScriptedSwipeClient(async () => ({
        success: true,
        totalTimeMs: 42,
        gestureTimeMs: 30,
        dispatched: true,
        acknowledged: true,
      })),
    );

    expect(
      await new ExecuteGesture(device).swipe({ x1: 1, y1: 2, x2: 10, y2: 2 }, { duration: 90 }),
    ).toEqual({
      success: true,
      x1: 1,
      y1: 2,
      x2: 10,
      y2: 2,
      duration: 90,
      a11yTotalTimeMs: 42,
      a11yGestureTimeMs: 30,
    });
  });
});

describe("ExecuteGesture iOS swipe over the real transport", () => {
  /** Wires the real delegate behind the client's request-object swipe. */
  function wire() {
    const h = createIosDelegateHarness();
    const gestures = new CtrlProxyGestures(h.context);
    const client = Object.assign(new FakeIOSCtrlProxy(h.timer), {
      requestSwipe: (request: SwipeRequest) => gestures.requestSwipe(request),
    });
    use(client);
    return h;
  }
  const flush = async () => {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  };

  test.each(["timeout", "socket close", "abort after dispatch"] as const)(
    "%s after the swipe was sent is indeterminate with one send",
    async (failure) => {
      const h = wire();
      const controller = new AbortController();
      const outcome = new ExecuteGesture(device, null, h.timer).swipe(
        { x1: 1, y1: 2, x2: 3, y2: 4 },
        {},
        { signal: controller.signal },
      );
      await flush();
      expect(h.sentMessages).toHaveLength(1);
      if (failure === "socket close") {
        h.requestManager.cancelAll(new Error("WebSocket connection closed"));
      } else if (failure === "abort after dispatch") {
        controller.abort(new Error("caller cancelled"));
      }
      h.advanceTime(5000);
      const result = await outcome;
      expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
      expect(result.error).toContain("Do not retry automatically.");
      expect(h.sentMessages).toHaveLength(1);
      expect(h.requestManager.getPendingCount()).toBe(0);
    },
  );

  test("a runner refusal reply is a plain failure", async () => {
    const h = wire();
    const outcome = new ExecuteGesture(device, null, h.timer).swipe({ x1: 1, y1: 2, x2: 3, y2: 4 });
    await flush();
    h.resolveLast({ success: false, totalTimeMs: 4, error: "runner refused" });
    const result = await outcome;
    expect(result).toMatchObject({ success: false, error: "runner refused" });
    expect(result.outcomeIndeterminate).toBeUndefined();
  });

  test("not connected is a plain failure and sends nothing", async () => {
    const h = wire();
    h.setConnected(false);
    const result = await new ExecuteGesture(device, null, h.timer).swipe({
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
    });
    expect(result).toMatchObject({ success: false, error: "Not connected" });
    expect(result.outcomeIndeterminate).toBeUndefined();
    expect(h.sentMessages).toHaveLength(0);
  });
});

describe("ExecuteGesture iOS XCUICoordinate velocity clamp (#12987)", () => {
  test("a 3000 ms / 100 pt swipe reports the clamped duration and a warning", async () => {
    use(new FakeIOSCtrlProxy());
    const result = await new ExecuteGesture(device).swipe(
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { duration: 3000 },
    );
    expect(result).toMatchObject({ success: true, duration: 3000, effectiveDurationMs: 1000 });
    expect(result.warnings?.[0]).toContain("clamped");
  });

  test("an in-range swipe carries no clamp report", async () => {
    use(new FakeIOSCtrlProxy());
    const result = await new ExecuteGesture(device).swipe(
      { x1: 0, y1: 0, x2: 300, y2: 0 },
      { duration: 300 },
    );
    expect(result.effectiveDurationMs).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });
});

describe("ExecuteGesture iOS swipe reports the dispatch route that ran (#13145)", () => {
  function usingReply(reply: Record<string, unknown>): void {
    const client = new FakeIOSCtrlProxy();
    client.setSwipeResult({ success: true, totalTimeMs: 5, ...reply });
    use(client);
  }

  test("unpinned synthesis below 50 ms reports the runner's 50 ms floor, not the XCUICoordinate clamp", async () => {
    usingReply({ swipeRoute: "unpinnedSynthesized", effectiveDurationMs: 50 });
    const result = await new ExecuteGesture(device).swipe(
      { x1: 0, y1: 0, x2: 300, y2: 0 },
      { duration: 10 },
    );
    expect(result).toMatchObject({
      success: true,
      duration: 10,
      effectiveDurationMs: 50,
      dispatchRoute: "unpinnedSynthesized",
    });
    expect(result.warnings?.[0]).toContain("unpinnedSynthesized");
  });

  test("a synthesized route is not clamped to 100-10000 pt/s", async () => {
    // 100 pt in 3000 ms would be clamped to 1000 ms on XCUICoordinate; synthesis honours 3000.
    usingReply({ swipeRoute: "lockScreenSynthesized", effectiveDurationMs: 3000 });
    const result = await new ExecuteGesture(device).swipe(
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { duration: 3000 },
    );
    expect(result.effectiveDurationMs).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(result.dispatchRoute).toBe("lockScreenSynthesized");
  });

  test("the XCUICoordinate route reports the duration the runner computed", async () => {
    usingReply({ swipeRoute: "xcuiCoordinate", effectiveDurationMs: 1000 });
    const result = await new ExecuteGesture(device).swipe(
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { duration: 3000 },
    );
    expect(result).toMatchObject({ effectiveDurationMs: 1000, dispatchRoute: "xcuiCoordinate" });
    expect(result.warnings?.[0]).toContain("clamped");
  });

  test("an older runner that reports no route keeps the XCUICoordinate assumption", async () => {
    usingReply({});
    const result = await new ExecuteGesture(device).swipe(
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { duration: 3000 },
    );
    expect(result).toMatchObject({ effectiveDurationMs: 1000 });
    expect(result.dispatchRoute).toBeUndefined();
  });
});
