import type { BootedDevice } from "../models";
import {
  defaultPowerClientFactory,
  type PowerClientFactory,
} from "../features/utility/power/AndroidPowerClient";
import {
  defaultPowerRegistry,
  type PowerRegistry,
  type SessionPower,
} from "../features/utility/power/PowerRegistry";
import { restoreSessionPower } from "../features/utility/power/PowerRestore";
import type { PowerRestoreReport } from "../features/utility/power/PowerTypes";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { SessionManager, SessionReleaseOptions } from "./sessionManager";
import { SESSION_RELEASE_TEARDOWN_CAP_MS } from "./sessionManager/sessionConstants";

export interface PowerSessionCleanupOptions {
  registry?: PowerRegistry;
  clientFactory?: PowerClientFactory;
  timer?: Pick<Timer, "sleep" | "setTimeout" | "clearTimeout">;
}

type PendingCleanupHost = Pick<SessionManager, "registerPendingDeviceCleanup">;

/**
 * Start restoring the power state `record.sessionId` changed, register it as pending device
 * cleanup (the next session cannot acquire the device mid-restore) and keep its outcome for the
 * release result.
 */
export function startPowerRestore(
  manager: PendingCleanupHost,
  record: SessionPower,
  options: PowerSessionCleanupOptions = {},
): Promise<PowerRestoreReport> {
  const device: BootedDevice = {
    name: record.deviceId,
    platform: "android",
    deviceId: record.deviceId,
  };
  // Not part of whichever request triggered the release: its abort must not cut the restore short.
  const restore = runOutsideRequestContext(async () =>
    restoreSessionPower(record, (options.clientFactory ?? defaultPowerClientFactory())(device), {
      timer: options.timer ?? defaultTimer,
    }),
  ).catch((error: unknown): PowerRestoreReport => {
    const detail = errorMessage(error);
    logger.warn(
      `[power] Restoring session ${record.sessionId}'s power state threw: ${detail}`,
      error,
    );
    return {
      status: "failed",
      deviceId: record.deviceId,
      fields: [],
      error: detail,
      leftover: `Device ${record.deviceId} may still carry power state (${record.changed.join(", ")}) session ${record.sessionId} changed.`,
    };
  });
  (options.registry ?? defaultPowerRegistry).noteRestore(record.sessionId, restore);
  manager.registerPendingDeviceCleanup(record.deviceId, restore, {
    name: "restore session power state",
    leftover: "the released session's battery, Doze, standby, saver or thermal changes",
  });
  return restore;
}

/**
 * Restore the power state a session changed with `setDeviceState` when that session is released
 * or moves off the device (#14084), on the same release and unbound seams as the screen-lock
 * cleanup. A device left in forced Doze or with a faked battery breaks the next session, so the
 * outcome is kept for the release result (`powerRestore`), not only logged.
 */
export function registerPowerSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: PowerSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultPowerRegistry;
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
      // A different device now answers on this serial; the changed one is gone with its state.
      logger.info(`[power] Session ${sessionId}'s ${deviceId} was replaced; not restoring`);
      registry.noteRestore(
        sessionId,
        Promise.resolve({
          status: "skipped",
          deviceId,
          fields: [],
          error: "The device was replaced before its power state could be restored.",
        }),
      );
      return;
    }
    void startPowerRestore(manager, record, options);
  };
  // A terminal upgrade of a finished release must not touch the device's next owner (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, _snapshot, releaseOptions) => {
    if (releaseOptions?.upgradeOnly) {
      return;
    }
    cleanup(sessionId, deviceId, releaseOptions);
  });
  manager.onSessionDeviceUnbound(cleanup);
}

/** A release result's `powerRestore`: the restore's outcome, or `pending` if still running. */
export type PowerReleaseReport = PowerRestoreReport | { status: "pending" };

const REPORT_WAIT_TIMEOUT = Symbol("power restore report wait");

/**
 * `powerRestore` for a release result: how restoring the session's power state went. Waits for
 * the restore its release started, at most the teardown cap; one still running then is reported
 * `pending` (its outcome is logged, and the device stays quarantined until it settles).
 */
export async function powerRestoreResult(
  sessionId: string,
  options: Pick<PowerSessionCleanupOptions, "registry" | "timer"> = {},
): Promise<{ powerRestore?: PowerReleaseReport }> {
  const pending = (options.registry ?? defaultPowerRegistry).restoreReport(sessionId);
  if (!pending) {
    return {};
  }
  const report = await raceWithDeadline(pending, {
    timer: options.timer ?? defaultTimer,
    timeoutMs: SESSION_RELEASE_TEARDOWN_CAP_MS,
    unref: true,
    label: "power restore report",
    timeoutError: () => REPORT_WAIT_TIMEOUT,
  }).catch((error: unknown) => {
    if (error !== REPORT_WAIT_TIMEOUT) {
      throw error;
    }
    return { status: "pending" as const };
  });
  return { powerRestore: report };
}
