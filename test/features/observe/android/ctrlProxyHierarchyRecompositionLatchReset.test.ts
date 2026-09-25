/**
 * The recomposition-tracking latch describes what the runner's accessibility service instance
 * holds, not what the host client holds. Any event that closes the WebSocket connection (a
 * crash rebind, an APK reinstall via `setup()`, or an ordinary drop) can restart that service
 * with `RecompositionStore.enabled == false` regardless of what was configured before the
 * close. Before `resetConnectionScopedState()`, the host latch stayed `configured=true` across
 * the close, so the next `setRecompositionTrackingEnabled(true)` returned without sending
 * anything and recomposition data silently disappeared for the rest of the client's lifetime
 * (issue #7540).
 */

import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/android/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("Android CtrlProxyHierarchy recomposition latch reset on reconnect (#7540)", () => {
  test("resends the tracking frame on a new connection after resetConnectionScopedState", async () => {
    const timer = new FakeTimer();
    const sent: string[] = [];
    const context: HierarchyDelegateContext = {
      getWebSocket: () =>
        ({
          readyState: 1,
          send: (message: string) => sent.push(message),
        }) as never,
      requestManager: new RequestManager(timer),
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
      device: { deviceId: "emulator-5554", platform: "android" } as never,
      adb: {} as never,
      getCachedHierarchy: () => null,
      setCachedHierarchy: () => {},
      getLastWebSocketTimeout: () => 0,
      setLastWebSocketTimeout: () => {},
    };
    const hierarchy = new CtrlProxyHierarchy(context);

    await hierarchy.setRecompositionTrackingEnabled(true);
    expect(sent).toHaveLength(1);

    // Regression: within the SAME connection, a repeated request for the same value must not
    // resend (existing behavior, must survive this fix).
    await hierarchy.setRecompositionTrackingEnabled(true);
    expect(sent).toHaveLength(1);

    // Simulate the WebSocket closing and a new one taking its place — the signal
    // `AndroidCtrlProxyClient.onConnectionClosed()` now forwards via `resetConnectionScopedState()`.
    hierarchy.resetConnectionScopedState();

    // The runner side reset too (service restart), so the next observe's request for the same
    // logical value ("keep tracking on") must go out again on the new connection.
    await hierarchy.setRecompositionTrackingEnabled(true);
    expect(sent).toHaveLength(2);

    // And it latches again for the new connection until the next reset.
    await hierarchy.setRecompositionTrackingEnabled(true);
    expect(sent).toHaveLength(2);
  });

  test("does not send anything extra when reset before tracking was ever configured", async () => {
    const timer = new FakeTimer();
    const sent: string[] = [];
    const context: HierarchyDelegateContext = {
      getWebSocket: () =>
        ({
          readyState: 1,
          send: (message: string) => sent.push(message),
        }) as never,
      requestManager: new RequestManager(timer),
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
      device: { deviceId: "emulator-5554", platform: "android" } as never,
      adb: {} as never,
      getCachedHierarchy: () => null,
      setCachedHierarchy: () => {},
      getLastWebSocketTimeout: () => 0,
      setLastWebSocketTimeout: () => {},
    };
    const hierarchy = new CtrlProxyHierarchy(context);

    hierarchy.resetConnectionScopedState();
    expect(sent).toHaveLength(0);

    await hierarchy.setRecompositionTrackingEnabled(false);
    // `enabled` defaults to false already, so a request to disable still sends once — this
    // assertion only guards that resetConnectionScopedState() itself is inert.
    expect(sent).toHaveLength(1);
  });
});
