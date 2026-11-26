import {
  defaultStatusBarControllerFactory,
  type StatusBarControllerFactory,
} from "../features/utility/StatusBarControllerFactory";
import {
  defaultStatusBarOverrideRegistry,
  type StatusBarOverrideStore,
} from "../features/utility/StatusBarOverrideRegistry";
import { defaultPowerRegistry, type PowerRegistry } from "../features/utility/power/PowerRegistry";
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
  /** Where the same release's power restore is found, to order the battery refresh after it. */
  powerRegistry?: Pick<PowerRegistry, "restoreReport">;
}

/**
 * Resolves once `sessionId`'s power restore settles, or when `signal` aborts. The power cleanup
 * runs on the same release (#14084) and resets or re-fakes the battery; the clear's battery
 * refresh reads, sets and resets it too, so interleaving them could leave the device faked
 * (#19189). Release listeners run synchronously, so the restore is registered before this runs.
 */
function powerRestoreSettled(
  powerRegistry: Pick<PowerRegistry, "restoreReport">,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const restore = powerRegistry.restoreReport(sessionId);
  if (!restore || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    // startPowerRestore already turns a thrown restore into a failed report.
    void restore.then(done, done);
  });
}

/**
 * Clear the status-bar override a session set when that session is released or moves off the
 * device (#14105), on the same release and unbound seams as the network and location cleanups.
 * The clear is registered as pending device cleanup so the next session does not acquire the
 * device while the release-time `simctl status_bar clear` / demo-mode `exit` is still in flight,
 * and it runs in the registry's per-device queue so it is ordered against the tool handler's
 * override and clear on the same device, sessionless ones included (#17084). Overrides a
 * sessionless call set are left alone.
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
  const powerRegistry = options.powerRegistry ?? defaultPowerRegistry;
  /**
   * Runs in the registry's device queue, after any status-bar mutation already queued on the
   * device (#17084): the record is read only once that mutation has settled, so a rejected
   * sessionless override's rollback that restores this session's record is cleared here, and a
   * sessionless override issued after the release waits for this clear instead of being undone by
   * it. A cleanup whose cap expired while it waited leaves the record and the device alone.
   */
  const clearOwnedOverride = async (
    sessionId: string,
    deviceId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (signal.aborted) {
      logger.warn(
        `[statusBar] Release cap expired before the status bar clear for session ${sessionId} on ${deviceId} could start; left the override in place`,
      );
      return;
    }
    const record = registry.takeOwnedBy(deviceId, sessionId);
    const controller = record ? controllerFor(record.device) : null;
    if (!controller) {
      return;
    }
    await runOutsideRequestContext(() =>
      controller.clear(signal, {
        beforeBatteryRefresh: () => powerRestoreSettled(powerRegistry, sessionId, signal),
      }),
    );
  };
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    // A mutation still queued on the device may restore this session's record when it settles.
    const deviceBusy = registry.hasDeviceWork(deviceId);
    if (!deviceBusy && registry.get(deviceId)?.sessionId !== sessionId) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      logger.debug(
        `[statusBar] Cleanup for session ${sessionId} on replaced serial ${deviceId}: skipped status bar clear`,
      );
      registry.takeOwnedBy(deviceId, sessionId);
      if (deviceBusy) {
        void registry.runOnDevice(deviceId, async () => {
          registry.takeOwnedBy(deviceId, sessionId);
        });
      }
      return;
    }
    const attempt = new AbortController();
    // The cap covers the wait behind a queued mutation as well as the clear itself.
    const clear = raceWithDeadline(
      () =>
        registry.runOnDevice(deviceId, () =>
          clearOwnedOverride(sessionId, deviceId, attempt.signal),
        ),
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
