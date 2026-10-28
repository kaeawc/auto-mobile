import { daemonResponseError } from "../../src/daemon/client/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { createFakeDaemonState } from "../daemon/helpers/inputSocketHarness";
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
  const state: DaemonStateAccess = {
    ...createFakeDaemonState(),
    isInitialized: () => true,
    getSessionManager: () => sessionManager,
  };
  return async (method, params) => {
    if (method !== "daemon/heartbeat") {
      return undefined;
    }
    const response = await handleDaemonRequest(
      { id: method, type: "daemon_request", method, params },
      state,
    );
    if (!response.success) {
      throw daemonResponseError({ id: method, type: "mcp_response", ...response });
    }
    return response.result;
  };
}

/**
 * One tokenless `daemon/heartbeat` frame for `sessionId`, delivered through
 * {@link daemonHeartbeatHandler}. The sanctioned replacement for calling
 * `sessionManager.recordHeartbeat(...)` in a test: the real handler admits it (or refuses it, in
 * which case this rejects) and then records it. Pass `params` for a keeper's owner token or claim.
 */
export async function deliverDaemonHeartbeat(
  sessionManager: SessionManager,
  sessionId: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return await daemonHeartbeatHandler(sessionManager)("daemon/heartbeat", {
    sessionId,
    ...params,
  });
}

/**
 * Like {@link deliverDaemonHeartbeat} for an owner that keeps heartbeating without knowing its
 * session is gone: the daemon's not-found answer is the outcome, reported as `false`, not a
 * failure. Any other refusal still rejects.
 */
export async function deliverDaemonHeartbeatIfKnown(
  sessionManager: SessionManager,
  sessionId: string,
  params: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    await deliverDaemonHeartbeat(sessionManager, sessionId, params);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === DAEMON_SESSION_NOT_FOUND_CODE) {
      return false;
    }
    throw error;
  }
}
