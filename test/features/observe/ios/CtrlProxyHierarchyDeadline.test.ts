import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/ios/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

function context(
  timer: FakeTimer,
  ensureConnected: () => Promise<boolean>,
  send: (data: string) => void,
): { context: HierarchyDelegateContext; requestManager: RequestManager } {
  const requestManager = new RequestManager(timer);
  return {
    context: {
      getWebSocket: () => ({ readyState: 1, send }) as never,
      requestManager,
      timer,
      ensureConnected,
      cancelScreenshotBackoff: () => {},
      cacheFreshTtlMs: 1_000,
      getCachedHierarchy: () => null,
      setCachedHierarchy: () => {},
    },
    requestManager,
  };
}

describe("CtrlProxyHierarchy synchronous deadline", () => {
  test("spends setup time from the hierarchy request budget before dispatch", async () => {
    const timer = new FakeTimer();
    let sends = 0;
    const harness = context(
      timer,
      async () => {
        timer.advanceTime(50);
        return true;
      },
      () => {
        sends += 1;
      },
    );

    const result = await new CtrlProxyHierarchy(harness.context).requestHierarchySync(
      undefined,
      false,
      undefined,
      50,
    );

    expect(result).toBeNull();
    expect(sends).toBe(0);
    expect(harness.requestManager.getPendingCount()).toBe(0);
  });

  test("returns at its deadline while connection setup is still pending", async () => {
    const timer = new FakeTimer();
    let sends = 0;
    const harness = context(
      timer,
      async () => await new Promise<boolean>(() => {}),
      () => {
        sends += 1;
      },
    );

    const request = new CtrlProxyHierarchy(harness.context).requestHierarchySync(
      undefined,
      false,
      undefined,
      50,
    );
    timer.advanceTime(50);

    await expect(request).resolves.toBeNull();
    expect(sends).toBe(0);
    expect(harness.requestManager.getPendingCount()).toBe(0);
  });

  test("cancels a registered hierarchy request when the caller aborts", async () => {
    const timer = new FakeTimer();
    const harness = context(
      timer,
      async () => true,
      () => {},
    );
    const controller = new AbortController();
    const request = new CtrlProxyHierarchy(harness.context).requestHierarchySync(
      undefined,
      false,
      controller.signal,
      100,
    );

    await Promise.resolve();
    controller.abort(new Error("caller cancelled"));

    await expect(request).rejects.toThrow("caller cancelled");
    expect(harness.requestManager.getPendingCount()).toBe(0);
  });
});
