import { describe, expect, test } from "bun:test";
import { CtrlProxyGestures } from "../../../../src/features/observe/ios/CtrlProxyGestures";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

const swipe = (
  h: ReturnType<typeof createIosDelegateHarness>,
  beforeSend: (() => void) | undefined,
) =>
  new CtrlProxyGestures(h.context).requestMultiFingerSwipe({
    x1: 1,
    y1: 2,
    x2: 3,
    y2: 4,
    fingerCount: 2,
    duration: 300,
    timeoutMs: 50,
    fingerSpacing: 10,
    beforeSend,
  });

describe("iOS requestMultiFingerSwipe beforeSend fence", () => {
  test("a throwing fence is reported as an undispatched failure with nothing sent", async () => {
    const h = createIosDelegateHarness();
    const stale = new Error("stale display");
    const result = await swipe(h, () => {
      throw stale;
    });
    expect(result).toMatchObject({
      success: false,
      error: "stale display",
      dispatched: false,
      acknowledged: false,
    });
    expect(h.sentMessages).toEqual([]);
  });

  test("a passing fence runs once, synchronously before the send", async () => {
    const h = createIosDelegateHarness();
    let sentAtFence = -1;
    let calls = 0;
    const pending = swipe(h, () => {
      calls++;
      sentAtFence = h.sentMessages.length;
    });
    await Promise.resolve();
    await Promise.resolve();
    h.resolveLast({ success: true, totalTimeMs: 1 });
    await pending;
    expect(calls).toBe(1);
    expect(sentAtFence).toBe(0);
    expect(h.sentMessages).toHaveLength(1);
  });
});
