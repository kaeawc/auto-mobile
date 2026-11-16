import type { Platform } from "../models";
import { logger } from "../utils/logger";
import type { RollbackAssignment } from "./devicePool";
import type { ForeignDeviceOwnership } from "./foreignDeviceOwnership";
import {
  SessionRecoveryIdentityLossError,
  type Session,
  type SessionManager,
  type SessionRecoveryTarget,
} from "./sessionManager";

/** The recovery a claim belongs to. */
export interface RecoveredClaimContext {
  sessionId: string;
  target: SessionRecoveryTarget;
  ownership: ForeignDeviceOwnership;
}

/** What claiming a recovered device needs from the pool. */
export interface RecoveredDeviceClaimPort {
  publishDeviceClaim(deviceId: string): Promise<boolean>;
  assertNotClaimedByForeignDaemon(deviceId: string, platform: Platform): Promise<void>;
  rollbackAssignments(assignments: ReadonlyMap<string, RollbackAssignment>): Promise<void>;
  readonly sessionManager: Pick<SessionManager, "restoreDeferredRecoveryClaim">;
}

/**
 * Claim the device a recovery attempt just assigned. A claim the host-wide table cannot decide yet
 * (#11811) comes back unassigned with `shouldWait`, so recovery retries within its deadline instead
 * of fencing the session; a live foreign owner still terminalizes it (#11076).
 */
export async function claimRecoveredAssignment<
  R extends { success: boolean; deviceId?: string; session?: Session; shouldWait: boolean },
>(port: RecoveredDeviceClaimPort, context: RecoveredClaimContext, result: R): Promise<R> {
  if (!result.success || result.deviceId === undefined || !result.session) {
    return result;
  }
  const claimed = await claimRecoveredDevice(port, context, {
    deviceId: result.deviceId,
    session: result.session,
  });
  return claimed === "deferred"
    ? { ...result, success: false, deviceId: undefined, session: undefined, shouldWait: true }
    : result;
}

/**
 * Publish this daemon's claim on the device recovery just rebound. When another live daemon's
 * claim won the race, give the device back and terminalize the session (#11076). When the table
 * only could not decide yet (#11811), give the device back, restore the persisted row's claimed
 * release so the retry can write over it, and report `deferred`.
 */
async function claimRecoveredDevice(
  port: RecoveredDeviceClaimPort,
  context: RecoveredClaimContext,
  { deviceId, session }: { deviceId: string; session: Session },
): Promise<"claimed" | "deferred"> {
  // The recovering session's id, not a device binding field.
  const recoveringSessionId = context.sessionId;
  const { target, ownership } = context;
  if (await port.publishDeviceClaim(deviceId)) {
    return "claimed";
  }
  const rollback = new Map([[recoveringSessionId, { deviceId, session }]]);
  if (ownership.claimDeferred?.(deviceId) === true) {
    logger.info(
      `[DevicePool] The device claims registry cannot decide ${deviceId} yet; releasing it from recovering session ${recoveringSessionId} to retry`,
    );
    await port.rollbackAssignments(rollback);
    // The rollback released the row as `allocation-rollback`; give the retry its claim back.
    await port.sessionManager.restoreDeferredRecoveryClaim(session);
    return "deferred";
  }
  logger.warn(
    `[DevicePool] Another AutoMobile process (PID ${ownership.foreignOwnerPid(deviceId)}) claims ${deviceId}; rolling back recovery of session ${recoveringSessionId}`,
  );
  await port.rollbackAssignments(rollback);
  // Rollback cleared the local holder, so the fresh explicit-bind refusal can name the winner.
  await port.assertNotClaimedByForeignDaemon(deviceId, target.platform);
  throw new SessionRecoveryIdentityLossError(recoveringSessionId, target, "owned-by-other-daemon", {
    deviceId,
    ownerPid: ownership.foreignOwnerPid(deviceId),
  });
}
