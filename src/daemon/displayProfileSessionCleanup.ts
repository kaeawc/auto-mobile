import type { SessionManager, SessionReleaseOptions } from "./sessionManager";
import {
  defaultDisplayProfileRestoreRegistry,
  type DisplayProfileRestoreRegistry,
  type OwnedDisplayProfileRestore,
} from "../features/utility/DisplayProfileRestore";
import { invalidateDisplayCaches } from "../features/observe/DisplayTransition";
import { restoreDisplayProfileAction } from "../features/utility/DisplayProfile";
import {
  defaultDisplayProfilePortsFactory,
  type DisplayProfilePortsFactory,
} from "../features/utility/DisplayProfilePorts";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

/** Bound on each facet restored at release; a posture change waits for its read-back. */
export const DISPLAY_PROFILE_RESTORE_TIMEOUT_MS = 5_000;

export interface DisplayProfileSessionCleanupOptions {
  registry?: DisplayProfileRestoreRegistry;
  portsFor?: DisplayProfilePortsFactory;
  timer?: Pick<Timer, "setTimeout" | "clearTimeout">;
  /** Clears cached observations and coordinates after a size or overlay restore (#14101). */
  invalidate?: (deviceId: string, reason: string) => void;
}

/**
 * Write every recorded facet back, latest first, each bounded and outside the
 * releasing request's abort context. Best effort: a failed facet is logged and
 * the rest still run. Resolves with the facets that could not be restored.
 */
export async function restoreOwnedDisplayProfile(
  owned: OwnedDisplayProfileRestore,
  portsFor: DisplayProfilePortsFactory,
  timer: Pick<Timer, "setTimeout" | "clearTimeout">,
  invalidate: (deviceId: string, reason: string) => void = invalidateDisplayCaches,
): Promise<string[]> {
  const ports = portsFor(owned.device);
  const failed: string[] = [];
  for (const action of owned.actions) {
    try {
      await runOutsideRequestContext(() =>
        raceWithDeadline(() => restoreDisplayProfileAction(ports, action), {
          timer,
          timeoutMs: DISPLAY_PROFILE_RESTORE_TIMEOUT_MS,
          label: `Restore display-profile ${action.facet}`,
        }),
      );
    } catch (error) {
      failed.push(action.facet);
      logger.warn(
        `Failed to restore display-profile ${action.facet} on ${owned.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
  }
  // A restored size or overlay moves the display geometry under every cached observation.
  if (
    owned.actions.some((action) =>
      ["screenSize", "cutout", "navigationMode"].includes(action.facet),
    )
  ) {
    invalidate(owned.device.deviceId, "Display geometry restored");
  }
  return failed;
}

/**
 * Restore every facet a session changed with `displayProfile` when that session
 * is released or moves off the device (#14052), on the same release and unbound
 * seams as `registerNetworkStateSessionCleanup`. The restore is registered as
 * pending device cleanup, so the next session cannot acquire the device while
 * its overlays, size or posture are still the released session's.
 */
export function registerDisplayProfileSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: DisplayProfileSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultDisplayProfileRestoreRegistry;
  const portsFor = options.portsFor ?? defaultDisplayProfilePortsFactory;
  const timer = options.timer ?? defaultTimer;
  const invalidate = options.invalidate ?? invalidateDisplayCaches;
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const owned = registry.takeOwnedBy(deviceId, sessionId);
    if (!owned) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      logger.debug(
        `Display-profile restore for session ${sessionId} on replaced serial ${deviceId}: skipped device writes`,
      );
      return;
    }
    manager.registerPendingDeviceCleanup(
      deviceId,
      restoreOwnedDisplayProfile(owned, portsFor, timer, invalidate),
      {
        name: "restore display profile",
        leftover:
          "the released session's screen size, display, overlay, force-dark and posture changes",
      },
    );
  };
  // A terminal upgrade of a finished release must not touch the device's next owner (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, releaseOptions) => {
    if (releaseOptions?.upgradeOnly) {
      return;
    }
    cleanup(sessionId, deviceId, releaseOptions);
  });
  manager.onSessionDeviceUnbound(cleanup);
}
