/**
 * Recomposition setup must not outlive the caller's bounded observation
 * request while CtrlProxy is reconnecting (#6932).
 */

import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/android/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { defaultTimer } from "../../../../src/utils/SystemTimer";
import { FakeTimer } from "../../../fakes/FakeTimer";

interface Harness {
  hierarchy: CtrlProxyHierarchy;
  /** Resolves once the fake handshake has actually been entered. */
  connectStarted: Promise<void>;
}

/** A context whose `ensureConnected` hangs exactly like a wedged handshake. */
function createHangingConnectHarness(): Harness {
  const timer = new FakeTimer();
  let markStarted: () => void = () => {};
  const connectStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const context: HierarchyDelegateContext = {
    getWebSocket: () => null,
    requestManager: new RequestManager(timer),
    timer,
    ensureConnected: () => {
      markStarted();
      return new Promise<boolean>(() => {});
    },
    cancelScreenshotBackoff: () => {},
    device: { deviceId: "emulator-5554", platform: "android" } as never,
    adb: {} as never,
    getCachedHierarchy: () => null,
    setCachedHierarchy: () => {},
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {},
  };

  return { hierarchy: new CtrlProxyHierarchy(context), connectStarted };
}

/** Fail loudly rather than hanging the suite when the cancellation fence is gone. */
async function withinBound<T>(operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = defaultTimer.setTimeout(
          () => reject(new Error("recomposition config outlived the caller's abort signal")),
          500,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      defaultTimer.clearTimeout(timeout);
    }
  }
}

describe("Android CtrlProxyHierarchy recomposition setup abort (#6932)", () => {
  test("stops waiting on a wedged handshake when the caller aborts", async () => {
    const h = createHangingConnectHarness();
    const controller = new AbortController();

    const pending = h.hierarchy.setRecompositionTrackingEnabled(true, undefined, controller.signal);
    await h.connectStarted;
    controller.abort();

    await expect(withinBound(pending)).resolves.toBeUndefined();
  });

  test("an already-aborted signal never enters the handshake at all", async () => {
    const h = createHangingConnectHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      withinBound(h.hierarchy.setRecompositionTrackingEnabled(true, undefined, controller.signal)),
    ).resolves.toBeUndefined();
    expect(await Promise.race([h.connectStarted.then(() => true), Promise.resolve(false)])).toBe(
      false,
    );
  });
});
