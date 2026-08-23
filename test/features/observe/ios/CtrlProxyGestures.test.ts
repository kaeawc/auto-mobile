import { describe, expect, it } from "bun:test";
import { CtrlProxyGestures } from "../../../../src/features/observe/ios/CtrlProxyGestures";
import type { DelegateContext } from "../../../../src/features/observe/ios/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

class CapturingRequestManager extends RequestManager {
  lastRegisteredType: string | null = null;

  override register<T>(
    id: string,
    type: string,
    timeoutMs: number,
    timeoutErrorFactory: (requestId: string, type: string, timeoutMs: number) => T,
    responseErrorFactory?: (error: string, totalTimeMs: number) => T,
  ): Promise<T> {
    this.lastRegisteredType = type;
    return super.register(id, type, timeoutMs, timeoutErrorFactory, responseErrorFactory);
  }
}

function createFakeContext(): {
  context: DelegateContext;
  sent: string[];
  requestManager: CapturingRequestManager;
} {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const sent: string[] = [];
  const requestManager = new CapturingRequestManager(timer);
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
    cancelScreenshotBackoff: () => {},
  };

  return { context, sent, requestManager };
}

async function callAndResolve<T>(
  sent: string[],
  requestManager: RequestManager,
  action: () => Promise<T>,
  result: unknown = { success: true, totalTimeMs: 1 },
): Promise<{ sentMsg: Record<string, unknown>; result: T }> {
  const promise = action();
  await Promise.resolve();
  await Promise.resolve();

  const sentMsg = JSON.parse(sent[sent.length - 1]);
  requestManager.resolve(sentMsg.requestId as string, result);

  return { sentMsg, result: await promise };
}

describe("iOS CtrlProxyGestures", () => {
  it("resolves the multi-finger swipe request by matching request id", async () => {
    const { context, sent } = createFakeContext();
    const gestures = new CtrlProxyGestures(context);

    const { sentMsg, result } = await callAndResolve(sent, context.requestManager, () =>
      gestures.requestMultiFingerSwipe(10, 20, 30, 40, 3, 450),
    );

    expect(sentMsg.type).toBe("request_multi_finger_swipe");
    expect(sentMsg.fingerCount).toBe(3);
    expect(context.requestManager.getPendingCount()).toBe(0);
    expect(result.success).toBe(true);
  });

  it("sends fractional multi-finger swipe spacing as offset", async () => {
    const { context, sent, requestManager } = createFakeContext();
    const gestures = new CtrlProxyGestures(context);

    const { sentMsg } = await callAndResolve(sent, requestManager, () =>
      gestures.requestMultiFingerSwipe(10, 20, 30, 40, 3, 450, 5000, undefined, 30.5),
    );

    expect(sentMsg.offset).toBe(30.5);
  });
});
