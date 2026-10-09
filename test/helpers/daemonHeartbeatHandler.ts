import { daemonResponseError } from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import type { SessionManager } from "../../src/daemon/sessionManager";

/**
 * Delivers a proxy's `daemon/heartbeat` to the daemon's REAL request handler over a real
 * {@link SessionManager}, resolving with the handler's `result` and rejecting with
 * `daemonResponseError` as the real client does (#10975). A test that fakes the daemon with
 * `sessionManager.recordHeartbeat(...)` bypasses ownership claims, policy adoption, refusals and
 * the ack payload (`idleReleaseAt`, `daemonInstance`) - the wire contract the liveness scenario
 * tests exist to pin. Use this as a `FakeDaemonClient` `onCallDaemonMethod` instead.
 */
export function daemonHeartbeatHandler(
  sessionManager: SessionManager,
): (method: string, params: Record<string, unknown>) => Promise<unknown> {
  const state = {
    isInitialized: () => true,
    getSessionManager: () => sessionManager,
  } as unknown as DaemonStateAccess;
  return async (method, params) => {
    if (method !== "daemon/heartbeat") {
      return undefined;
    }
    const response = await handleDaemonRequest(
      { id: method, type: "daemon_request", method, params },
      state,
    );
    if (!response.success) {
      throw daemonResponseError({ id: method, type: "daemon_response", ...response });
    }
    return response.result;
  };
}
