import {
  defaultStatusBarControllerFactory,
  type StatusBarControllerFactory,
} from "../features/utility/StatusBarControllerFactory";
import {
  defaultStatusBarOverrideRegistry,
  type StatusBarOverrideStore,
} from "../features/utility/StatusBarOverrideRegistry";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  type SessionManager,
  type SessionReleaseOptions,
} from "./sessionManager";

export interface StatusBarSessionCleanupOptions {
  registry?: StatusBarOverrideStore;
  controllerFor?: StatusBarControllerFactory;
  timer?: Timer;
}

/**
 * Clear the status-bar override a session set when that session is released or moves off the
 * device (#14105), on the same release and unbound seams as the network and location cleanups.
 * The clear is registered as pending device cleanup so the next session does not acquire the
 * device while the release-time `simctl status_bar clear` / demo-mode `exit` is still in flight.
 * Overrides a sessionless call set are left alone.
 */
export function registerStatusBarSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: StatusBarSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultStatusBarOverrideRegistry;
  const controllerFor = options.controllerFor ?? defaultStatusBarControllerFactory;
  const timer = options.timer ?? defaultTimer;
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const record = registry.takeOwnedBy(deviceId, sessionId);
    if (!record) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      logger.debug(
        `[statusBar] Cleanup for session ${sessionId} on replaced serial ${deviceId}: skipped status bar clear`,
      );
      return;
    }
    const controller = controllerFor(record.device);
    if (!controller) {
      return;
    }
    const attempt = new AbortController();
    const clear = raceWithDeadline(
      () => runOutsideRequestContext(() => controller.clear(attempt.signal)),
      {
        timer,
        timeoutMs: SESSION_RELEASE_TEARDOWN_CAP_MS,
        unref: true,
        label: "Status bar clear",
        onTimeout: () => attempt.abort(),
      },
    ).catch((error: unknown) => {
      logger.warn(
        `[statusBar] Failed to clear status bar override on ${deviceId}: ${errorMessage(error)}`,
        error,
      );
    });
    manager.registerPendingDeviceCleanup(deviceId, clear, {
      name: "clear status bar override",
      leftover: "the released session's status bar override",
    });
  };
  manager.onSessionRelease((sessionId, deviceId, _reason, releaseOptions) => {
    // A terminal upgrade of a finished release would clear the next owner's override (#10825).
    if (releaseOptions?.upgradeOnly) {
      return;
    }
    cleanup(sessionId, deviceId, releaseOptions);
  });
  manager.onSessionDeviceUnbound(cleanup);
}

/** The daemon's device-removal callback: nothing remains on the device to clear. */
export function forgetStatusBarOverrideForRemovedDevice(
  deviceId: string,
  registry: StatusBarOverrideStore = defaultStatusBarOverrideRegistry,
): void {
  registry.forget(deviceId);
}
