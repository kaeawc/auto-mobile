import type { SessionManager } from "../daemon/sessionManager";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { NetworkState } from "./NetworkState";

/** Pushes a device's current host-side network state (rules + simulation) to it. */
export interface NetworkDeviceStatePusher {
  push(deviceId: string): Promise<void>;
}

/**
 * Re-sync through the connected CtrlProxy client of whichever platform owns the
 * device. A device with no live client has nothing to clear: the next connect
 * pushes its (now empty) state.
 */
export const defaultNetworkDeviceStatePusher: NetworkDeviceStatePusher = {
  async push(deviceId: string): Promise<void> {
    AndroidCtrlProxyClient.getExistingInstance(deviceId)?.syncNetworkStateToDevice();
    await IOSCtrlProxyClient.getExistingInstance(deviceId)?.syncNetworkStateFromHost();
  },
};

export interface NetworkStateSessionCleanupOptions {
  /** Resolved lazily per call so a replaced singleton is always honoured. */
  state?: () => NetworkState;
  pusher?: NetworkDeviceStatePusher;
}

async function pushClearedState(pusher: NetworkDeviceStatePusher, deviceId: string): Promise<void> {
  try {
    await pusher.push(deviceId);
  } catch (error) {
    logger.warn(
      `[networkState] Failed to push cleared network state to ${deviceId}: ${errorMessage(error)}`,
      error,
    );
  }
}

/**
 * Remove the mock rules and error simulation a session installed when that
 * session is released or moves off the device (issue #10061), the same way the
 * other session-scoped device state is restored. Registers on the existing
 * release and unbound seams (see `registerLocationRouteSessionCleanup`).
 *
 * The host store is cleared synchronously so a reconnect racing the release can
 * only push an empty set; the device push is registered as pending device
 * cleanup so the next session does not acquire the device mid-push. State a
 * sessionless call installed is left alone.
 */
export function registerNetworkStateSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: NetworkStateSessionCleanupOptions = {},
): void {
  const pusher = options.pusher ?? defaultNetworkDeviceStatePusher;
  const cleanup = (sessionId: string, deviceId: string): void => {
    const state = options.state?.() ?? NetworkState.getInstance();
    if (!state.clearDeviceOwnedBySession(deviceId, sessionId)) {
      return;
    }
    manager.registerPendingDeviceCleanup(deviceId, pushClearedState(pusher, deviceId));
  };
  manager.onSessionRelease(cleanup);
  manager.onSessionDeviceUnbound(cleanup);
}

/**
 * A session acquiring a device clears the sessionless mocks and simulation on it (#11130), so
 * state no session owns cannot outlive the free period and shape the new holder's traffic. Mirrors
 * `createOwnerlessRecordingAcquisitionCleanup`: returns the callback to run where acquisition
 * cancels sessionless executions, and tracks the device push as acquisition cleanup so the
 * acquiring holder's own reuse is not refused.
 */
export function createOwnerlessNetworkStateAcquisitionCleanup(
  manager: Pick<SessionManager, "registerAcquisitionDeviceCleanup">,
  options: NetworkStateSessionCleanupOptions = {},
): (deviceId: string) => void {
  const pusher = options.pusher ?? defaultNetworkDeviceStatePusher;
  return (deviceId) => {
    const state = options.state?.() ?? NetworkState.getInstance();
    if (!state.clearSessionlessDeviceState(deviceId)) {
      return;
    }
    manager.registerAcquisitionDeviceCleanup(deviceId, pushClearedState(pusher, deviceId));
  };
}
