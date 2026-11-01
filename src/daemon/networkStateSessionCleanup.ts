import { raceWithDeadline } from "../utils/raceWithDeadline";
import { ActionableError } from "../models/ActionableError";
import { runOutsideRequestContext } from "../utils/AbortContext";
import type { SdkCapabilityQueryOptions } from "../features/observe/ios/CtrlProxySdkCapabilities";
import {
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  type SessionManager,
  type SessionReleaseOptions,
} from "./sessionManager";
import { registerBoundedAcquisitionCleanup } from "../utils/boundedAcquisitionCleanup";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { NetworkState } from "../utils/NetworkState";
import { isIosUdid } from "../utils/ios-cmdline-tools/iosDeviceType";

/** Pushes a device's current host-side network state (rules + simulation) to it. */
export interface NetworkDeviceStatePusher {
  push(deviceId: string, options?: SdkCapabilityQueryOptions): Promise<void>;
}

/**
 * Re-sync through the connected CtrlProxy client of whichever platform owns the
 * device. A missing live client rejects: delivery cannot be established until
 * a later connection pushes the current host state.
 */
export const defaultNetworkDeviceStatePusher: NetworkDeviceStatePusher = {
  async push(deviceId: string, options?: SdkCapabilityQueryOptions): Promise<void> {
    // The platform that owns the id decides: a stray, never-connected Android client keyed by
    // an iOS UDID must not veto (or stand in for) the iOS push (#15179). Any other id keeps
    // the Android push first, so a stray iOS client can never hide it.
    const ios = IOSCtrlProxyClient.getExistingInstance(deviceId);
    const android = isIosUdid(deviceId)
      ? null
      : AndroidCtrlProxyClient.getExistingInstance(deviceId);
    if (!android && !ios) {
      throw new ActionableError(`No live CtrlProxy client to clear network state on ${deviceId}`);
    }
    if (android?.syncNetworkStateToDevice() === false) {
      throw new ActionableError(`Android network state was not delivered to ${deviceId}`);
    }
    await ios?.syncNetworkStateFromHost(options);
  },
};

export interface NetworkStateSessionCleanupOptions {
  /** Captured synchronously at release/unbind before the cleared-state push starts. */
  gapMarkerFor?: (sessionId: string) => (reason: string) => void;
  /** Resolved lazily per call so a replaced singleton is always honoured. */
  state?: () => NetworkState;
  pusher?: NetworkDeviceStatePusher;
  timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
}

async function pushClearedState(
  pusher: NetworkDeviceStatePusher,
  deviceId: string,
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  onFailure?: (error: unknown) => void,
): Promise<void> {
  const controller = new AbortController();
  const deadlineMs = timer.now() + SESSION_RELEASE_TEARDOWN_CAP_MS;
  const handle = timer.setTimeout(
    () => controller.abort(new Error("Network cleanup deadline expired")),
    SESSION_RELEASE_TEARDOWN_CAP_MS,
  );
  handle.unref?.();
  try {
    await raceWithDeadline(
      () =>
        runOutsideRequestContext(() =>
          pusher.push(deviceId, { deadlineMs, abortSignal: controller.signal }),
        ),
      { timer, signal: controller.signal, label: "push cleared network state" },
    );
  } catch (error) {
    logger.warn(
      `[networkState] Failed to push cleared network state to ${deviceId}: ${errorMessage(error)}`,
      error,
    );
    try {
      onFailure?.(error);
    } catch (markError) {
      logger.warn("[networkState] Failed to mark uncleared network state", markError);
    }
  } finally {
    timer.clearTimeout(handle);
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
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const state = options.state?.() ?? NetworkState.getInstance();
    if (!state.clearDeviceOwnedBySession(deviceId, sessionId)) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      logger.debug(
        `[networkState] Cleanup for session ${sessionId} on replaced serial ${deviceId}: skipped cleared-state device push`,
      );
      return;
    }
    const markGap = options.gapMarkerFor?.(sessionId);
    // iOS probes capability before reading CURRENT rules; simulation is read after
    // that push settles. Android reads and sends synchronously. A late push therefore
    // delivers the current holder's host state, never a captured cleared snapshot.
    manager.registerPendingDeviceCleanup(
      deviceId,
      pushClearedState(pusher, deviceId, options.timer ?? defaultTimer, (error) => {
        markGap?.(
          `network mock rules and simulation may remain on ${deviceId}: ${errorMessage(error)}`,
        );
      }),
      {
        name: "push cleared network state",
        leftover: "the released session's network mock rules and error simulation",
      },
    );
  };
  manager.onSessionRelease((sessionId, deviceId, _reason, releaseOptions) => {
    cleanup(sessionId, deviceId, releaseOptions);
  });
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
    registerBoundedAcquisitionCleanup(
      manager,
      deviceId,
      pushClearedState(pusher, deviceId, options.timer ?? defaultTimer),
      {
        timer: options.timer ?? defaultTimer,
        capMs: SESSION_RELEASE_TEARDOWN_CAP_MS,
        label: "push cleared network state",
      },
    );
  };
}
