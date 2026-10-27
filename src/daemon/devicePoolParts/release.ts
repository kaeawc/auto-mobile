import { getIosLockStateCache } from "../../features/observe/ios/IosLockStateCacheRegistry";
import { restoreBinding, snapshotBinding, unbindDevice, holderOf, isBusy } from "../deviceBinding";
import type { SessionReleaseReason } from "../releaseReasons";
import { currentAllocationCancellationScope } from "../allocationCancellationScope";
import { logger } from "../../utils/logger";
import { displayTransitions } from "../../features/observe/DisplayTransition";
import { getObserveCacheStore } from "../../features/observe/cache/ObserveCacheRegistry";
import { type Session } from "../sessionManager";
import { ActionableError } from "../../models";
import type { PooledDevice } from "../devicePoolTypes";
import {
  RollbackAssignment,
  SessionAssignmentSnapshot,
  CREATE_SESSION_RELEASE_WAIT_MS,
} from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface ReleaseOperations {
  rollbackAssignments(
    assignments: ReadonlyMap<string, RollbackAssignment>,
    releaseReason?: SessionReleaseReason,
  ): Promise<void>;
  snapshotSessionAssignment(device: PooledDevice): SessionAssignmentSnapshot;
  restoreSessionAssignment(device: PooledDevice, snapshot: SessionAssignmentSnapshot): void;
  createSessionOrRestore(
    device: PooledDevice,
    snapshot: SessionAssignmentSnapshot,
    createSession: () => Promise<Session>,
  ): Promise<Session>;
  createSessionAndCommit(
    device: PooledDevice,
    snapshot: SessionAssignmentSnapshot,
    createSession: () => Promise<Session>,
  ): Promise<Session>;
  isSessionAssignmentCurrent(device: PooledDevice, session: Session): boolean;
  releaseDevice(deviceId: string, expectedSessionId: string): Promise<void>;
  captureReleasedDevice(sessionId: string, deviceId: string): void;
  releaseCapturedDevice(
    device: PooledDevice,
    expectedSessionId: string,
    expectedAssignmentCount: number,
  ): Promise<void>;
  isCapturedReleaseCurrent(
    device: PooledDevice,
    expectedSessionId: string,
    expectedAssignmentCount: number,
  ): boolean;
}
type ReleaseState = Pick<
  DevicePoolState,
  | "assignmentMutex"
  | "devices"
  | "sessionManager"
  | "pooledSessionIdentities"
  | "releasedDeviceCaptures"
  | "deferredDeviceReleases"
  | "autolockManager"
  | "lastReleasedDeviceId"
  | "multiDeviceAllocations"
>;
export type ReleaseCallbacks = Pick<
  DevicePoolOperations,
  "releaseDevice" | "isPooledEntryCurrent" | "releaseDeviceClaim" | "notifyDeviceStateChanged"
>;

/** Release responsibilities of DevicePool. */
export class DevicePoolRelease {
  constructor(
    private readonly state: ReleaseState,
    private readonly callbacks: ReleaseCallbacks,
  ) {}
  /**
   * Undo the completed portion of a failed multi-device allocation.
   *
   * The mutex keeps a new allocation from taking ownership between releasing
   * the session and returning its device to the idle pool. The recorded Session
   * object prevents a reused UUID from making this rollback release a replacement
   * allocation.
   */
  async rollbackAssignments(
    assignments: ReadonlyMap<string, RollbackAssignment>,
    releaseReason: SessionReleaseReason = "allocation-rollback",
  ): Promise<void> {
    await this.state.assignmentMutex.runExclusive(async () => {
      for (const [sessionId, allocation] of assignments) {
        const { deviceId, session: allocatedSession } = allocation;
        currentAllocationCancellationScope()?.discard(sessionId);
        const device = this.state.devices.get(deviceId);
        if (!device || holderOf(device) !== sessionId) {
          logger.warn(
            `[DevicePool] Skipping allocation rollback for ${sessionId}: ` +
              `device ${deviceId} is no longer owned by that session`,
          );
          continue;
        }
        const currentSession = this.state.sessionManager.getSession(sessionId);
        if (currentSession !== allocatedSession) {
          if (currentSession?.assignedDevice === deviceId) {
            logger.warn(
              `[DevicePool] Preserving replacement session ${sessionId} on ${deviceId} ` +
                `during allocation rollback`,
            );
            continue;
          }
          logger.warn(
            `[DevicePool] Releasing stale allocation of ${deviceId} for replaced session ${sessionId}`,
          );
          await this.callbacks.releaseDevice(deviceId, sessionId);
          continue;
        }
        if (allocatedSession.assignedDevice !== deviceId) {
          logger.warn(
            `[DevicePool] Preserving session ${sessionId} on ${allocatedSession.assignedDevice} ` +
              `while releasing stale allocation of ${deviceId}`,
          );
          await this.callbacks.releaseDevice(deviceId, sessionId);
          continue;
        }
        await this.state.sessionManager.releaseSession(sessionId, releaseReason);
        const replacementSession = this.state.sessionManager.getSession(sessionId);
        if (replacementSession?.assignedDevice === deviceId) {
          logger.warn(
            `[DevicePool] Preserving replacement session ${sessionId} on ${deviceId} ` +
              `during allocation rollback`,
          );
          continue;
        }
        await this.callbacks.releaseDevice(deviceId, sessionId);
      }
    });
  }

  snapshotSessionAssignment(device: PooledDevice): SessionAssignmentSnapshot {
    return {
      ...snapshotBinding(device),
      lastUsedAt: device.lastUsedAt,
      assignmentCount: device.assignmentCount,
      errorCount: device.errorCount,
      autolockSessionId: device.autolockSessionId,
    };
  }

  restoreSessionAssignment(device: PooledDevice, snapshot: SessionAssignmentSnapshot): void {
    restoreBinding(device, snapshot);
    const { lastUsedAt, assignmentCount, errorCount, autolockSessionId } = snapshot;
    Object.assign(device, { lastUsedAt, assignmentCount, errorCount, autolockSessionId });
  }

  async createSessionOrRestore(
    device: PooledDevice,
    snapshot: SessionAssignmentSnapshot,
    createSession: () => Promise<Session>,
  ): Promise<Session> {
    const attemptedSessionId = holderOf(device);
    // Sessionless calls on the device are cancelled once the create commits, not at publish: the
    // checks below can still refuse it or roll it back, leaving the device free (#10905).
    const deferredSessionId = attemptedSessionId;
    if (deferredSessionId) {
      this.state.sessionManager.deferDeviceAcquisitionCancellation(deferredSessionId);
    }
    let committed = false;
    let heldByAllocation = false;
    try {
      const session = await this.createSessionAndCommit(device, snapshot, createSession);
      committed = true;
      // A multi-device allocation settles every device together (#10929).
      const allocationScope = currentAllocationCancellationScope();
      if (deferredSessionId && allocationScope) {
        allocationScope.hold(deferredSessionId);
        heldByAllocation = true;
      }
      return session;
    } finally {
      if (deferredSessionId && !heldByAllocation) {
        this.state.sessionManager.settleDeviceAcquisitionCancellation(deferredSessionId, committed);
      }
    }
  }

  async createSessionAndCommit(
    device: PooledDevice,
    snapshot: SessionAssignmentSnapshot,
    createSession: () => Promise<Session>,
  ): Promise<Session> {
    const attemptedSessionId = holderOf(device);
    try {
      const session = await createSession();
      if (session.assignedDevice !== device.id) {
        if (
          this.callbacks.isPooledEntryCurrent(device) &&
          holderOf(device) === attemptedSessionId
        ) {
          this.restoreSessionAssignment(device, snapshot);
        }
        return session;
      }
      const currentSession = this.state.sessionManager.getSession(session.sessionId);
      if (currentSession !== session && currentSession?.assignedDevice === device.id) {
        // The attempted incarnation was replaced while its write completed.
        // Return the attempted object so rollback can preserve the replacement.
        return session;
      }
      const releaseSettled = await this.state.sessionManager.waitForSessionReleaseWithin(
        session.sessionId,
        CREATE_SESSION_RELEASE_WAIT_MS,
      );
      if (!releaseSettled) {
        logger.warn(
          `Refusing session ${session.sessionId} on ${device.id}: a release admitted during its ` +
            `creation has not settled after ${CREATE_SESSION_RELEASE_WAIT_MS}ms ` +
            "(reason=create-release-wait-timeout)",
        );
        throw new ActionableError(
          `Session ${session.sessionId} was released while it was being created on device ` +
            `'${device.id}', and that release has not finished after ` +
            `${CREATE_SESSION_RELEASE_WAIT_MS}ms. Retry the request to acquire a device.`,
        );
      }
      // A tracked process can exit while the durable session write is pending.
      // Do not publish success for a device that eviction already removed or
      // released; undo the just-published session before restoring the pool.
      if (!this.isSessionAssignmentCurrent(device, session)) {
        await this.state.sessionManager.releaseSession(
          session.sessionId,
          `device-disconnected-during-session-create:${device.id}`,
        );
        throw new ActionableError(
          `Device '${device.id}' disconnected while its session was being created.`,
        );
      }
      this.state.pooledSessionIdentities.set(device, session);
      return session;
    } catch (error) {
      if (this.callbacks.isPooledEntryCurrent(device) && holderOf(device) === attemptedSessionId) {
        this.restoreSessionAssignment(device, snapshot);
      }
      throw error;
    }
  }

  // createSessionOrRestore / DeviceAutolockManager check the session object and busy
  // assignment, including a held suspect session; automation admission is separate.
  isSessionAssignmentCurrent(device: PooledDevice, session: Session): boolean {
    return (
      this.callbacks.isPooledEntryCurrent(device) &&
      holderOf(device) === session.sessionId &&
      isBusy(device) &&
      this.state.sessionManager.getSession(session.sessionId) === session
    );
  }

  /**
   * Release device from session
   *
   * Called when a session completes or times out.
   * Frees the device so it can be assigned to other sessions.
   */
  async releaseDevice(deviceId: string, expectedSessionId: string): Promise<void> {
    const releasedCapture = this.state.releasedDeviceCaptures.get(expectedSessionId);
    if (releasedCapture?.deviceId === deviceId) {
      this.state.releasedDeviceCaptures.delete(expectedSessionId);
      await this.releaseCapturedDevice(
        releasedCapture.device,
        expectedSessionId,
        releasedCapture.assignmentCount,
      );
      return;
    }
    const device = this.state.devices.get(deviceId);
    if (!device) {
      logger.warn(`Cannot release device ${deviceId}: not in pool`);
      return;
    }
    await this.releaseCapturedDevice(device, expectedSessionId, device.assignmentCount);
  }

  captureReleasedDevice(sessionId: string, deviceId: string): void {
    const device = this.state.devices.get(deviceId);
    if (!device || holderOf(device) !== sessionId) {
      return;
    }
    this.state.releasedDeviceCaptures.set(sessionId, {
      device,
      deviceId,
      assignmentCount: device.assignmentCount,
    });
  }

  async releaseCapturedDevice(
    device: PooledDevice,
    expectedSessionId: string,
    expectedAssignmentCount: number,
  ): Promise<void> {
    const deviceId = device.id;
    if (!this.isCapturedReleaseCurrent(device, expectedSessionId, expectedAssignmentCount)) {
      return;
    }
    const existingDeferredRelease = this.state.deferredDeviceReleases.get(deviceId);
    if (existingDeferredRelease) {
      if (
        existingDeferredRelease.device === device &&
        existingDeferredRelease.sessionId === expectedSessionId &&
        existingDeferredRelease.assignmentCount === expectedAssignmentCount
      ) {
        return;
      }
      this.state.deferredDeviceReleases.delete(deviceId);
    }
    const cleanup = this.state.sessionManager.getPendingDeviceCleanup(deviceId);
    if (cleanup) {
      const deferredRelease = {
        device,
        sessionId: expectedSessionId,
        assignmentCount: expectedAssignmentCount,
        cleanup,
      };
      this.state.deferredDeviceReleases.set(deviceId, deferredRelease);
      void cleanup
        .then(() => {
          if (
            this.state.deferredDeviceReleases.get(deviceId) !== deferredRelease ||
            device.assignmentCount !== expectedAssignmentCount
          ) {
            return;
          }
          this.state.deferredDeviceReleases.delete(deviceId);
          return this.releaseCapturedDevice(device, expectedSessionId, expectedAssignmentCount);
        })
        .catch((error) =>
          logger.warn(`Failed to release device ${deviceId} after late session teardown: ${error}`),
        );
      logger.info(`Keeping device ${deviceId} assigned until late session teardown completes`);
      return;
    }
    const sessionId = holderOf(device);
    unbindDevice(device);
    displayTransitions.reset(deviceId);
    getObserveCacheStore().clear(deviceId);
    getIosLockStateCache().invalidate(deviceId);
    device.errorCount = 0;
    // Idempotent and keyed on the released session id: every path that ends ownership
    // (including a late chained cleanup) clears a stale autolock here, and a newer
    // autolock or replacement owner is left alone by the manager's guards (#10665).
    if (sessionId) {
      this.state.autolockManager.clearExpiredAutolockStateWhenIdle(
        sessionId,
        device,
        expectedAssignmentCount,
      );
    }
    this.callbacks.releaseDeviceClaim(deviceId);
    this.state.lastReleasedDeviceId = deviceId;
    this.state.multiDeviceAllocations.notify();
    logger.info(`Released device ${deviceId} from session ${sessionId}`);
    this.callbacks.notifyDeviceStateChanged(device);
  }

  // releaseCapturedDevice checks assignment generation, but permits release after
  // the session has left SessionManager and does not require a busy status.
  isCapturedReleaseCurrent(
    device: PooledDevice,
    expectedSessionId: string,
    expectedAssignmentCount: number,
  ): boolean {
    const deviceId = device.id;
    if (!this.callbacks.isPooledEntryCurrent(device)) {
      logger.debug(`Ignoring stale release for replacement device ${deviceId}`);
      return false;
    }
    if (device.assignmentCount !== expectedAssignmentCount) {
      logger.debug(`Ignoring stale release for reassigned device ${deviceId}`);
      return false;
    }
    if (holderOf(device) !== expectedSessionId) {
      logger.warn(
        `Cannot release device ${deviceId}: expected session ${expectedSessionId}, ` +
          `but it is owned by ${holderOf(device) ?? "no session"}`,
      );
      return false;
    }
    if (!holderOf(device)) {
      logger.debug(`Device ${deviceId} is already idle`);
      return false;
    }
    return true;
  }
}

export function connectRelease(
  part: () => DevicePoolRelease,
  seams: Pick<DevicePoolOperations, "releaseDevice">,
): ReleaseOperations {
  return {
    rollbackAssignments: (...args) => part().rollbackAssignments(...args),
    snapshotSessionAssignment: (...args) => part().snapshotSessionAssignment(...args),
    restoreSessionAssignment: (...args) => part().restoreSessionAssignment(...args),
    createSessionOrRestore: (...args) => part().createSessionOrRestore(...args),
    createSessionAndCommit: (...args) => part().createSessionAndCommit(...args),
    isSessionAssignmentCurrent: (...args) => part().isSessionAssignmentCurrent(...args),
    releaseDevice: (...args) => seams.releaseDevice(...args),
    captureReleasedDevice: (...args) => part().captureReleasedDevice(...args),
    releaseCapturedDevice: (...args) => part().releaseCapturedDevice(...args),
    isCapturedReleaseCurrent: (...args) => part().isCapturedReleaseCurrent(...args),
  };
}
