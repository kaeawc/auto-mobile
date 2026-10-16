import { describe, expect, it } from "bun:test";
import { CtrlProxyGestures } from "../../../../src/features/observe/android/CtrlProxyGestures";
import type { DelegateContext } from "../../../../src/features/observe/shared/types";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { RequestManager } from "../../../../src/utils/RequestManager";

function createContext(supported: ReadonlySet<string>) {
  const timer = new FakeTimer();
  const requestManager = new RequestManager(timer);
  const sent: string[] = [];
  const context: DelegateContext = {
    getWebSocket: () => ({ send: (data: string) => sent.push(data), readyState: 1 }) as never,
    requestManager,
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    // Request types are supported; capability flags only when advertised.
    isCommandSupported: (name: string) => !name.endsWith("_v1") || supported.has(name),
  };
  return { context, sent, requestManager };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const request = (fingerCount: number) => ({
  x1: 100,
  y1: 200,
  x2: 100,
  y2: 100,
  fingerCount,
  duration: 300,
  fingerSpacing: 80,
  timeoutMs: 5000,
});

describe("Android multi-finger wire request (#12535)", () => {
  it("sends fingerCount and the spacing as offset when the capability is advertised", async () => {
    const { context, sent, requestManager } = createContext(new Set(["multi_finger_gesture_v1"]));
    const pending = new CtrlProxyGestures(context).requestMultiFingerSwipe(request(4));
    await flush();
    const message = JSON.parse(sent[0]);
    expect(message).toMatchObject({
      type: "request_two_finger_swipe",
      x1: 100,
      y1: 200,
      x2: 100,
      y2: 100,
      duration: 300,
      offset: 80,
      fingerCount: 4,
    });
    requestManager.resolve(message.requestId, { success: true, totalTimeMs: 1 });
    expect((await pending).success).toBe(true);
  });

  it("refuses more than two fingers on a runner without the capability, sending nothing", async () => {
    const { context, sent } = createContext(new Set());
    const result = await new CtrlProxyGestures(context).requestMultiFingerSwipe(request(3));
    await flush();
    expect(sent).toEqual([]);
    expect(result).toMatchObject({
      success: false,
      unsupportedCapability: "multi_finger_gesture_v1",
    });
  });

  it("keeps the legacy wire for two fingers: no fingerCount, no capability needed", async () => {
    const { context, sent, requestManager } = createContext(new Set());
    const pending = new CtrlProxyGestures(context).requestMultiFingerSwipe(request(2));
    await flush();
    const message = JSON.parse(sent[0]);
    expect(message).not.toHaveProperty("fingerCount");
    expect(message.offset).toBe(80);
    requestManager.resolve(message.requestId, { success: true, totalTimeMs: 1 });
    await pending;
  });
});
