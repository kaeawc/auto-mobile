/**
 * The Android hierarchy delegate must let the caller's signal end a WebSocket
 * handshake it is waiting on (#6890 review, P1).
 *
 * `DeviceServiceClient.ensureConnected` permits the handshake to run for
 * 5000ms and takes no cancellation signal. Both hierarchy reads await it before
 * they reach any of their own `throwIfAborted` checkpoints, so a caller whose
 * bound is much tighter — the #6866 embedded-observation settle gate advertises
 * 1s and combines it into the signal it hands down — was fenced by nothing
 * until that handshake resolved on its own.
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

/**
 * Fail loudly instead of hanging to the suite timeout when the fence is gone.
 * A real timer deliberately: what is under test is a read that must not
 * outlive a REAL-clock bound, and the harness drives no fake clock forward.
 */
async function withinBound<T>(operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = defaultTimer.setTimeout(
          () => reject(new Error("read outlived the caller's abort signal")),
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

describe("Android CtrlProxyHierarchy connection abort (#6890)", () => {
  test("getLatestHierarchy stops waiting on a wedged handshake when the caller aborts", async () => {
    const h = createHangingConnectHarness();
    const controller = new AbortController();

    const pending = h.hierarchy.getLatestHierarchy(
      false,
      1000,
      undefined,
      false,
      0,
      controller.signal,
    );
    await h.connectStarted;
    controller.abort();

    // Degrades the way every other failure in this read does: no hierarchy,
    // not fresh — and promptly, rather than 5s from now.
    expect(await withinBound(pending)).toEqual({ hierarchy: null, fresh: false });
  });

  test("requestHierarchySync stops waiting on a wedged handshake when the caller aborts", async () => {
    const h = createHangingConnectHarness();
    const controller = new AbortController();

    const pending = h.hierarchy.requestHierarchySync(undefined, false, controller.signal, 1000);
    await h.connectStarted;
    controller.abort();

    expect(await withinBound(pending)).toBeNull();
  });

  test("an already-aborted signal never enters the handshake at all", async () => {
    const h = createHangingConnectHarness();
    const controller = new AbortController();
    controller.abort();

    const result = await withinBound(
      h.hierarchy.getLatestHierarchy(false, 1000, undefined, false, 0, controller.signal),
    );

    expect(result).toEqual({ hierarchy: null, fresh: false });
  });
});
