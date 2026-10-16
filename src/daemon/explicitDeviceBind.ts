import { bindDevice, unbindDevice, holderOf } from "./deviceBinding";
import { releasePoolDevice } from "./releaseSessionAndDevice";
import { ActionableError, type BootedDevice, type DeviceInfo, type Platform } from "../models";
import { throwIfRequestAborted } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import type { AmbientExecutionIdReader } from "../utils/interfaces/AmbientExecutionIdReader";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import {
  mintedSession,
  requestAcquisitionReceipt,
  runWithAcquisitionReceipt,
  type AcquisitionReceipt,
  type DeferredRebindCleanup,
} from "./acquisitionReceipt";
import {
  DeviceOwnedByOtherDaemonError,
  freshStartAlreadyBoundError,
} from "./deviceAcquisitionRefusals";
import type { AutolockClient, DeviceAutolockManager } from "./deviceAutolockManager";
import {
  CREATE_SESSION_RELEASE_WAIT_MS,
  type DevicePool,
  type DeviceAutolockChildProcess as ChildProcess,
  type DeviceSessionExecutionCanceller,
  type PooledDevice,
  type SessionAssignmentSnapshot,
  type TargetDeviceDiscoveryOptions,
  type TargetDeviceDiscoverySnapshot,
  type TargetDeviceValidationOptions,
} from "./devicePool";
import type { DeviceRuntimeIdentity } from "./deviceRuntimeIdentity";
import type { ForeignDeviceOwnership } from "./foreignDeviceOwnership";
import {
  deviceAssignedToOtherSessionError,
  heldDeviceBindRefusal,
  InputDeviceOwnedError,
} from "./inputDeviceOwnership";
import type { ManagedSlotExclusion } from "./managedSlots/managedSlotExclusion";
import type { SessionReleaseReason } from "./releaseReasons";
import {
  ANONYMOUS_ACQUISITION_SESSION_SOURCE,
  isAnonymousAcquisitionSession,
  type Session,
  type SessionCacheData,
  type SessionManager,
  type SessionRecoveryTarget,
} from "./sessionManager";
import { launchProcessLiveness } from "./transitionalAdbBindWait";

export interface ExplicitDeviceBindPort extends Pick<
  DevicePool,
  | "beginMcpBind"
  | "assertNotClaimedByForeignDaemon"
  | "assertNotAssignedToManagedSlot"
  | "assertDeviceCleanupComplete"
  | "matchesRestartRecoveryTarget"
  | "assertNotPreparedForOtherRequest"
  | "releaseDevice"
  | "holderReleaseRemainingMs"
> {
  readonly devices: Pick<ReadonlyMap<string, PooledDevice>, "get">;
  readonly sessionManager: Pick<
    SessionManager,
    | "getSession"
    | "getSessionForDevice"
    | "getPendingDeviceCleanup"
    | "createSession"
    | "invalidateAutomationReadiness"
    | "rebindSession"
    | "getOrCreateSession"
  >;
  readonly runtimeIdentity: Pick<DeviceRuntimeIdentity, "assertRuntimeIdentity">;
  readonly managedSlotExclusion: ManagedSlotExclusion | undefined;
  readonly cancelDeviceSessionExecutions: Pick<
    DeviceSessionExecutionCanceller,
    "cancelDeviceExecutions"
  >;
  readonly ambientExecutionIdReader: Pick<AmbientExecutionIdReader, "getExecutionId"> | undefined;
  readonly autolockManager: Pick<DeviceAutolockManager, "clearRebindAutolockLock">;
  readonly timer: Timer;
  withTargetDeviceDiscovery(options: TargetDeviceDiscoveryOptions): Promise<string>;
  recordSourceAndroidAvd(deviceId: string, sourceImage?: DeviceInfo): void;
  notifyTargetDeviceReady(options: {
    device: PooledDevice;
    snapshot: TargetDeviceDiscoverySnapshot;
  }): void;
  trackStartedDeviceProcess(
    device: BootedDevice,
    childProcess: ChildProcess | null | undefined,
  ): Promise<void>;
  assertIdleDeviceAssignable(options: TargetDeviceValidationOptions): void;
  validateOrReloadIdlePooledDevice(
    options: TargetDeviceValidationOptions,
  ): Promise<PooledDevice | undefined>;
  notifyDeviceStateChanged(device: Pick<PooledDevice, "id" | "platform">): void;
  foreignOwnershipFor(platform: Platform | undefined): ForeignDeviceOwnership | undefined;
  recordBindOwnership(mcpSessionId: string | undefined, sessionId: string): boolean;
  assertCallerOwnsDeviceSession(
    caller: AutolockClient | undefined,
    session: Session,
    device: PooledDevice,
    spawnedDevice?: boolean,
  ): boolean;
  assertNotReservedForShutdown(device: PooledDevice, detail: string): void;
  assertNotReservedForOtherRehydration(device: PooledDevice, sessionId: string | undefined): void;
  recoveryNow(): number;
  recoveryAssignmentError(sessionId: string, target: SessionRecoveryTarget): ActionableError;
  ownershipSessionId(sessionId: string): string;
  hasConnectedMcpSessionOwner(namedSessionId: string, exceptMcpSessionId?: string): boolean;
  snapshotSessionAssignment(device: PooledDevice): SessionAssignmentSnapshot;
  nextLastUsedAt(): number;
  createSessionOrRestore(
    device: PooledDevice,
    snapshot: SessionAssignmentSnapshot,
    createSession: () => Promise<Session>,
  ): Promise<Session>;
  stableDeviceIdFor(device: PooledDevice): string | undefined;
  recordMintedSessionOwnership(
    mcpSessionId: string | undefined,
    sessionId: string,
    oneShotCli: boolean,
    clientSuppliedId?: boolean,
  ): boolean;
  publishDeviceClaim(deviceId: string): Promise<boolean>;
  rollbackAssignments(
    assignments: ReadonlyMap<string, { deviceId: string; session: Session }>,
    releaseReason?: SessionReleaseReason,
  ): Promise<void>;
}

/** The optional inputs of {@link DevicePool.bindOrReuseDeviceSession}, by name. */
export interface ExplicitBindOptions {
  sourceImage?: DeviceInfo;
  childProcess?: ChildProcess | null;
  expectedIdentity?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">;
  allowSessionRebind: boolean;
  readinessReservationOwners?: ReadonlySet<symbol>;
  verifiedAndroidAvdIdentity?: DeviceInfo;
  expectedExistingSessionDeviceId?: string;
  mcpSessionId?: string;
  oneShotCli: boolean;
  /** Records the session this call mints: the only thing a failed or undelivered bind takes back. */
  receipt: AcquisitionReceipt;
  /** A selection by a request that prepared nothing: see {@link DevicePool.assertNotPreparedForOtherRequest}. */
  refusePreparedForOtherRequest: boolean;
  deferRebindCleanup: boolean;
  recoveryTarget?: SessionRecoveryTarget;
}

/**
 * The session overrides `SessionManager`'s rebind restores on the device the session leaves. A
 * session moved back to that device (an undone rebind) no longer has them applied there.
 */
const OVERRIDES_A_REBIND_RESTORES = [
  "keepScreenAwake",
  "biometricEnrollment",
  "networkCondition",
  "clock",
  "rotation",
  "screenReader",
] as const satisfies ReadonlyArray<keyof SessionCacheData>;

/**
 * The persisted creator kind of a session a pool bind creates (#11071): an acquisition (not a
 * caller-chosen session rebind or a recovery) by an anonymous caller is anonymous, and only
 * another anonymous acquisition may reuse it, keeping repeated `--cli` startDevice idempotent
 * (#2421). A one-shot `--cli` connection is anonymous by its explicit marker even though the
 * socket forwards a per-connection MCP id (#11096); a caller with no MCP id at all cannot prove
 * any ownership and is anonymous too. Every other MCP connection is identified.
 */
function creatorPersistenceSource(
  caller: AutolockClient,
  allowSessionRebind: boolean,
  expectedExistingSessionDeviceId: string | undefined,
): string | undefined {
  return isAnonymousCaller(caller) &&
    !allowSessionRebind &&
    expectedExistingSessionDeviceId === undefined
    ? ANONYMOUS_ACQUISITION_SESSION_SOURCE
    : undefined;
}

function isAnonymousCaller(caller: AutolockClient | undefined): boolean {
  return caller?.oneShotCli === true || caller?.mcpSessionId === undefined;
}

export class ExplicitDeviceBind {
  constructor(private readonly port: ExplicitDeviceBindPort) {}

  /**
   * Bind a known device to a session without running the pool's idle-device
   * selection. If the device is already bound to a live session, reuse that
   * session so repeated startDevice calls stay idempotent.
   */
  async bindOrReuseDeviceSession(
    sessionId: string,
    deviceId: string,
    platform: Platform,
    sourceImage?: DeviceInfo,
    childProcess?: ChildProcess | null,
    expectedIdentity?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
    allowSessionRebind = false,
    readinessReservationOwners?: ReadonlySet<symbol>,
    verifiedAndroidAvdIdentity?: DeviceInfo,
    expectedExistingSessionDeviceId?: string,
    mcpSessionId?: string,
    oneShotCli = false,
    receipt?: AcquisitionReceipt,
    refusePreparedForOtherRequest = false,
    recoveryTarget?: SessionRecoveryTarget,
  ): Promise<string> {
    // Registered before the first await so a close racing the whole bind is seen (#11146).
    const endBind = this.port.beginMcpBind(mcpSessionId);
    try {
      return await this.bindOrReuseDeviceSessionUnderBindClaim(sessionId, deviceId, platform, {
        recoveryTarget,
        sourceImage,
        childProcess,
        expectedIdentity,
        allowSessionRebind,
        readinessReservationOwners,
        verifiedAndroidAvdIdentity,
        expectedExistingSessionDeviceId,
        mcpSessionId,
        oneShotCli,
        receipt: receipt ?? {},
        deferRebindCleanup: receipt !== undefined,
        refusePreparedForOtherRequest,
      });
    } finally {
      endBind();
    }
  }

  private async bindOrReuseDeviceSessionUnderBindClaim(
    sessionId: string,
    deviceId: string,
    platform: Platform,
    options: ExplicitBindOptions,
  ): Promise<string> {
    const {
      sourceImage,
      childProcess,
      expectedIdentity,
      readinessReservationOwners,
      verifiedAndroidAvdIdentity,
      expectedExistingSessionDeviceId,
      mcpSessionId,
      oneShotCli,
    } = options;
    const caller: AutolockClient = { mcpSessionId, oneShotCli };
    await this.port.assertNotClaimedByForeignDaemon(deviceId, platform);
    if (this.port.managedSlotExclusion) {
      await this.port.assertNotAssignedToManagedSlot({
        action: "acquire",
        deviceId,
        platform,
        stableIds: [
          platform === "android" ? (verifiedAndroidAvdIdentity ?? sourceImage)?.name : undefined,
        ],
        requesterSessionUuid: sessionId,
      });
    }
    const heldBefore = holderOf(this.port.devices.get(deviceId)) ?? null;
    const boundSessionId = await this.port.withTargetDeviceDiscovery({
      deviceId,
      sessionId,
      readinessReservationOwners,
      sourceImage: verifiedAndroidAvdIdentity ?? sourceImage,
      isLaunchProcessAlive: launchProcessLiveness(childProcess),
      expectedIdentity,
      unavailableMessage: `Device '${deviceId}' is not available in the device pool.`,
      platform,
      operation: async (snapshot) => {
        throwIfRequestAborted();
        const androidAvdIdentity = verifiedAndroidAvdIdentity ?? sourceImage;
        const alreadyPooled = snapshot.capturedEntry !== undefined;
        let device = this.port.devices.get(deviceId);
        if (!device) {
          throw new ActionableError(`Device '${deviceId}' is not available in the device pool.`);
        }
        this.port.runtimeIdentity.assertRuntimeIdentity(device, expectedIdentity);
        this.assertExplicitBindReservations(device, sessionId, options);
        if (alreadyPooled) {
          this.port.recordSourceAndroidAvd(deviceId, androidAvdIdentity);
          this.port.notifyTargetDeviceReady({ device, snapshot });
        }
        await this.port.trackStartedDeviceProcess(
          {
            deviceId: device.id,
            name: device.name,
            platform: device.platform,
          },
          childProcess,
        );
        if (this.port.devices.get(deviceId) !== device) {
          throw new ActionableError(`Device '${deviceId}' exited before it could be assigned.`);
        }
        this.port.assertIdleDeviceAssignable({
          device,
          unavailableMessage: `Device '${deviceId}' is not available in the device pool.`,
          readinessReservationOwners,
          snapshot,
        });

        const validatedDevice = await this.port.validateOrReloadIdlePooledDevice({
          device,
          expectedIdentity,
          unavailableMessage:
            `Device '${deviceId}' is not available in the device pool. ` +
            "It may have been shut down or disconnected.",
          readinessReservationOwners,
          snapshot,
        });
        if (!validatedDevice) {
          return undefined;
        }
        device = validatedDevice;

        throwIfRequestAborted();
        if (this.port.devices.get(deviceId) !== device) {
          return undefined;
        }
        this.port.assertDeviceCleanupComplete(deviceId);
        if (holderOf(device)) {
          const existingSession = this.port.sessionManager.getSession(holderOf(device)!);
          if (
            existingSession &&
            existingSession.assignedDevice === deviceId &&
            existingSession.platform === device.platform
          ) {
            this.assertExistingRecoverySessionOwner(
              existingSession,
              sessionId,
              deviceId,
              expectedExistingSessionDeviceId,
            );
            const confirmedSameOwner = this.confirmBoundSessionOwner(
              device,
              existingSession,
              sessionId,
              options,
            );
            return this.reuseExistingDeviceSession(
              deviceId,
              existingSession,
              sessionId,
              sourceImage,
              confirmedSameOwner,
            );
          }

          if (existingSession) {
            this.assertRetainedRebindOwner(existingSession, sessionId, deviceId);
          } else {
            // Looking up an expired owner may itself start its release.
            this.port.assertDeviceCleanupComplete(deviceId);
            unbindDevice(device);
            this.port.notifyDeviceStateChanged(device);
          }
        }

        await this.assignDeviceToBoundSession(device, sessionId, platform, caller, options);
        logger.info(`Bound device ${deviceId} to session ${sessionId}`);
        return sessionId;
      },
    });
    if (this.port.foreignOwnershipFor(platform)) {
      await this.claimExplicitlyBoundDevice(
        boundSessionId,
        deviceId,
        heldBefore,
        options.receipt.minted?.session,
      );
    }
    return boundSessionId;
  }

  private confirmBoundSessionOwner(
    device: PooledDevice,
    session: Session,
    sessionId: string,
    options: ExplicitBindOptions,
  ): boolean {
    if (options.recoveryTarget && session.sessionId === sessionId) {
      // The issued-row recovery and prepared-target checks proved R, even when its control
      // call won the assignment before this start could restore the connection ownership.
      this.port.recordBindOwnership(options.mcpSessionId, sessionId);
      return true;
    }
    return this.port.assertCallerOwnsDeviceSession(
      { mcpSessionId: options.mcpSessionId, oneShotCli: options.oneShotCli },
      session,
      device,
      Boolean(options.childProcess),
    );
  }

  /** Only the cancelled receipt may re-hold its stale pool assignment without idling it. */
  private assertRetainedRebindOwner(session: Session, sessionId: string, deviceId: string): void {
    const undo = requestAcquisitionReceipt();
    const holder = this.port.sessionManager.getSessionForDevice(deviceId);
    if (
      session.sessionId !== sessionId ||
      undo?.rebound?.session !== session ||
      undo.rebound.fromDeviceId !== deviceId ||
      !undo.deferredRebindCleanup?.retained ||
      (holder !== null && holder !== sessionId)
    ) {
      throw deviceAssignedToOtherSessionError(deviceId, holder ?? session.sessionId, sessionId);
    }
  }

  /** Called under the assignment mutex every readiness reservation takes, before bind side effects. */
  private assertExplicitBindReservations(
    device: PooledDevice,
    sessionId: string,
    options: ExplicitBindOptions,
  ): void {
    this.port.assertNotReservedForShutdown(device, "and cannot be assigned");
    this.port.assertNotReservedForOtherRehydration(device, sessionId);
    const target = options.recoveryTarget;
    if (
      target &&
      !this.port.matchesRestartRecoveryTarget(
        { deviceId: device.id, name: device.name, platform: device.platform },
        target,
      )
    ) {
      throw new ActionableError(
        `Cannot safely recover session ${sessionId}: prepared device does not match its recovery target.`,
      );
    }
    // Admission as the restart owner never becomes an ordinary bind after its fixed window.
    if (
      target?.restartRecoveryDeadlineMs !== undefined &&
      this.port.recoveryNow() >= target.restartRecoveryDeadlineMs
    ) {
      throw this.port.recoveryAssignmentError(sessionId, target);
    }
    if (options.refusePreparedForOtherRequest) {
      this.port.assertNotPreparedForOtherRequest(device.id, options.readinessReservationOwners);
    }
  }

  private assertLabelBindOwner(caller: AutolockClient, sessionId: string, deviceId: string): void {
    // A connection may not mint or rebind a label session of a base another connection owns
    // (#11586): the bind records its caller as the owner, and a label's owner is its base's.
    if (
      caller.mcpSessionId !== undefined &&
      this.port.ownershipSessionId(sessionId) !== sessionId &&
      this.port.hasConnectedMcpSessionOwner(sessionId, caller.mcpSessionId)
    ) {
      throw new InputDeviceOwnedError(
        "Device acquisition",
        deviceId,
        sessionId,
        undefined,
        `Session ${sessionId} is a device label of a session another connected client owns, ` +
          `so device '${deviceId}' cannot be bound to it. Acquire the device under your own session.`,
      );
    }
  }

  /** Assign `device` to `sessionId`, create (or restore) the session and record its owner. */
  private boundSessionWasMinted(
    previousSession: Session | null,
    options: ExplicitBindOptions,
    clientChosen: boolean,
  ): boolean {
    return (
      previousSession === null &&
      !options.recoveryTarget &&
      (!options.allowSessionRebind || clientChosen)
    );
  }

  private async assignDeviceToBoundSession(
    device: PooledDevice,
    sessionId: string,
    platform: Platform,
    caller: AutolockClient,
    options: ExplicitBindOptions,
  ): Promise<void> {
    const deviceId = device.id;
    const { allowSessionRebind, expectedExistingSessionDeviceId } = options;
    this.assertLabelBindOwner(caller, sessionId, deviceId);
    const assignmentSnapshot = this.port.snapshotSessionAssignment(device);
    const previousSession = this.port.sessionManager.getSession(sessionId);
    const previousDeviceId = previousSession?.assignedDevice;
    const previousPlatform = previousSession?.platform;
    // Copied before the rebind: it replaces the session's cache and its restores edit the old one.
    const previousCacheData = previousSession ? { ...previousSession.cacheData } : undefined;
    this.assertExpectedRecoverySession(
      previousSession,
      sessionId,
      deviceId,
      platform,
      expectedExistingSessionDeviceId,
    );
    bindDevice(device, sessionId);
    device.lastUsedAt = this.port.nextLastUsedAt();
    device.assignmentCount++;
    device.errorCount = 0;

    const session = await this.port.createSessionOrRestore(
      device,
      assignmentSnapshot,
      this.createSessionForBinding(
        previousSession,
        sessionId,
        deviceId,
        platform,
        allowSessionRebind,
        {
          stableDeviceId: this.port.stableDeviceIdFor(device),
          deferCleanup: options.deferRebindCleanup
            ? (cleanup) => {
                options.receipt.deferredRebindCleanup = cleanup;
              }
            : undefined,
          persistenceSource: creatorPersistenceSource(
            caller,
            allowSessionRebind,
            expectedExistingSessionDeviceId,
          ),
          recoveryTarget: options.recoveryTarget,
        },
      ),
    );
    // A restored session predates this call. A session minted under the id its client chose is
    // recorded as such here, at the commit, so a failure of anything after it (the claim publish
    // included) takes it back without retiring the id. A session moved off another device is
    // recorded with where it was (#11593).
    const clientChosen = options.receipt.clientChosenSessionId === sessionId;
    if (this.boundSessionWasMinted(previousSession, options, clientChosen)) {
      options.receipt.minted = mintedSession(session, deviceId, clientChosen);
    } else if (previousDeviceId && previousDeviceId !== deviceId && previousCacheData) {
      options.receipt.rebound = {
        session,
        deviceId,
        fromDeviceId: previousDeviceId,
        fromPlatform: previousPlatform ?? platform,
        cacheData: previousCacheData,
      };
    }
    if (options.receipt.minted?.session === session) {
      this.port.recordMintedSessionOwnership(
        caller.mcpSessionId,
        sessionId,
        caller.oneShotCli === true,
        options.receipt.minted.clientSuppliedId === true,
      );
    } else {
      this.port.recordBindOwnership(caller.mcpSessionId, sessionId);
    }
    this.port.notifyDeviceStateChanged(device);
  }

  /**
   * Publish this daemon's claim on an explicitly bound device. Another daemon can claim it between
   * the pre-bind check and here; then a fresh bind is rolled back and refused like the check
   * (#10980). A device this daemon already held keeps its session.
   *
   * The publish is awaited after the session committed. When it throws, `createdSession` (the
   * session this very acquisition minted, absent for a reused or rebound one) is released again
   * rather than left holding the device under a call that failed (#11565).
   */
  async claimExplicitlyBoundDevice(
    sessionId: string,
    deviceId: string,
    heldBefore: string | null,
    createdSession?: Session,
  ): Promise<void> {
    let claimed: boolean;
    try {
      claimed = await this.port.publishDeviceClaim(deviceId);
    } catch (error) {
      if (createdSession) {
        logger.warn(
          `[DevicePool] Publishing the claim on ${deviceId} failed; releasing it from session ${sessionId}: ${errorMessage(error)}`,
          error,
        );
        await this.port.rollbackAssignments(
          new Map([[sessionId, { deviceId, session: createdSession }]]),
        );
      }
      throw error;
    }
    if (claimed) {
      return;
    }
    const session = this.port.sessionManager.getSession(sessionId);
    if (heldBefore === sessionId || !session) {
      logger.warn(
        `[DevicePool] Another AutoMobile process still claims ${deviceId}; session ${sessionId} already held it here`,
      );
      return;
    }
    logger.info(
      `[DevicePool] Another AutoMobile process claimed ${deviceId} first; releasing it from session ${sessionId}`,
    );
    await this.port.rollbackAssignments(new Map([[sessionId, { deviceId, session }]]));
    throw new DeviceOwnedByOtherDaemonError(
      deviceId,
      this.port
        .foreignOwnershipFor(this.port.devices.get(deviceId)?.platform)
        ?.foreignOwnerPid(deviceId),
    );
  }

  /**
   * Take back an acquisition whose result never reached its caller: the request was cancelled or
   * timed out while the bind was still finishing (typically publishing its cross-daemon claim), so
   * no client holds the session id. Only the session the acquisition minted is released, for good,
   * and only while it still holds the device; the claim goes with the device. A session that was
   * reused, has been replaced, or was already released is left alone (#11565). A session the call
   * moved from another device is moved back there, and one minted under an id its client chose is
   * rolled back without retiring that id, which the client will name again (#11593).
   */
  async releaseUndeliveredAcquisition(receipt: AcquisitionReceipt): Promise<void> {
    const { minted, rebound } = receipt;
    if (rebound) {
      await this.restoreUndeliveredRebind(rebound, receipt.deferredRebindCleanup);
    }
    if (!minted) {
      return;
    }
    const { session, deviceId } = minted;
    logger.info(
      `[DevicePool] Acquisition of ${deviceId} was cancelled before its session ${session.sessionId} was delivered; releasing it`,
    );
    await this.port.rollbackAssignments(
      new Map([[session.sessionId, { deviceId, session }]]),
      minted.clientSuppliedId ? "allocation-rollback" : "session-creation-cancelled",
    );
  }

  /**
   * Move a session back to the device it held before a rebind whose result never reached its
   * caller. The session is only moved while it is still the one the rebind produced, on the device
   * the rebind put it on. When its previous device cannot take it back (another session acquired
   * it meanwhile) the session stays whole on the new device rather than bound to neither.
   */
  private async restoreUndeliveredRebind(
    rebound: NonNullable<AcquisitionReceipt["rebound"]>,
    cleanup?: DeferredRebindCleanup,
  ): Promise<void> {
    const { session, deviceId, fromDeviceId } = rebound;
    const { sessionId } = session;
    const overridesStillRetained = () => cleanup?.retained === true;
    let outcome: "rebound" | "failed" = "failed";
    try {
      const current = this.port.sessionManager.getSession(sessionId);
      if (current !== session || current.assignedDevice !== deviceId) {
        cleanup?.commit();
        logger.info(
          `[DevicePool] Not restoring cancelled rebind of session ${sessionId}: it no longer holds ${deviceId}`,
        );
        return;
      }
      logger.info(
        `[DevicePool] Rebind of session ${sessionId} to ${deviceId} was cancelled before it was delivered; moving it back to ${fromDeviceId}`,
      );
      await this.cancelAndSettleRebindCleanup(fromDeviceId, sessionId, cleanup);
      await runWithAcquisitionReceipt({ rebound, deferredRebindCleanup: cleanup }, () =>
        this.bindOrReuseDeviceSession(
          sessionId,
          fromDeviceId,
          rebound.fromPlatform,
          undefined,
          undefined,
          undefined,
          true,
        ),
      );
      // Moving back was a rebind too, and a rebind keeps only the session's routing cache. The
      // session is on the device that cache described again, so it gets back what still describes
      // that device: its display pin, readiness and observation baselines. When undo cancelled
      // deferred cleanup and its gate is still retained after the bind, all six overrides are
      // still applied and their records come back too. If either deadline started restores,
      // including during the awaited bind, omit those records to keep the cache honest.
      // Label routing is session-level, so whatever it is now stays.
      if (
        this.port.sessionManager.getSession(sessionId) !== session ||
        session.assignedDevice !== fromDeviceId
      ) {
        return;
      }
      const restored: SessionCacheData = {
        ...rebound.cacheData,
        ...(session.cacheData.deviceLabels === undefined
          ? {}
          : { deviceLabels: session.cacheData.deviceLabels }),
      };
      if (!overridesStillRetained()) {
        for (const override of OVERRIDES_A_REBIND_RESTORES) {
          delete restored[override];
        }
      }
      session.cacheData = restored;
      cleanup?.resumeRetainedState();
      outcome = "rebound";
    } catch (error) {
      logger.warn(
        `[DevicePool] Session ${sessionId} stays on ${deviceId}: its previous device ${fromDeviceId} could not take it back: ${errorMessage(error)}`,
        error,
      );
    } finally {
      cleanup?.finish(outcome);
    }
  }

  /** Cancel the receipt's gate, or join its already-started restores, before attempting A. */
  private async cancelAndSettleRebindCleanup(
    deviceId: string,
    sessionId: string,
    cleanup: DeferredRebindCleanup | undefined,
  ): Promise<boolean> {
    const holder = this.port.sessionManager.getSessionForDevice(deviceId);
    if (holder !== null && holder !== sessionId) {
      cleanup?.commit();
      throw new ActionableError(`Previous device ${deviceId} is now held by session ${holder}.`);
    }
    if (!cleanup) {
      return false;
    }
    const retained = cleanup.cancel();
    // Keep a cancelled receipt's gate closed, joining only unrelated work. Started restores
    // still join the full quarantine bookkeeping outside the assignment mutex, boundedly.
    const pending = this.port.sessionManager.getPendingDeviceCleanup(
      deviceId,
      retained ? cleanup.settled : undefined,
    );
    await raceWithDeadline(Promise.all(retained ? [pending] : [cleanup.settled, pending]), {
      timer: this.port.timer,
      timeoutMs: CREATE_SESSION_RELEASE_WAIT_MS,
      label: "Undelivered rebind cleanup",
    });
    return retained;
  }

  private assertExpectedRecoverySession(
    session: Session | null,
    sessionId: string,
    deviceId: string,
    platform: Platform,
    expectedDeviceId: string | undefined,
  ): void {
    if (
      expectedDeviceId !== undefined &&
      (!session || session.assignedDevice !== expectedDeviceId || session.platform !== platform)
    ) {
      throw new ActionableError(
        `Session '${sessionId}' changed while device '${deviceId}' was recovering.`,
      );
    }
  }

  private assertExistingRecoverySessionOwner(
    session: Session,
    sessionId: string,
    deviceId: string,
    expectedDeviceId: string | undefined,
  ): void {
    if (expectedDeviceId !== undefined && session.sessionId !== sessionId) {
      throw new ActionableError(
        `Session '${sessionId}' changed while device '${deviceId}' was recovering.`,
      );
    }
  }

  private createSessionForBinding(
    previousSession: Session | null,
    sessionId: string,
    deviceId: string,
    platform: Platform,
    allowSessionRebind: boolean,
    creation: {
      stableDeviceId: string | undefined;
      persistenceSource: string | undefined;
      deferCleanup?: (cleanup: DeferredRebindCleanup) => void;
      recoveryTarget?: SessionRecoveryTarget;
    },
  ): () => Promise<Session> {
    const { stableDeviceId, persistenceSource } = creation;
    const previousDeviceId = previousSession?.assignedDevice;
    if (!previousDeviceId || previousDeviceId === deviceId) {
      return async () => {
        const session = await this.port.sessionManager.createSession(
          sessionId,
          deviceId,
          platform,
          creation.recoveryTarget?.liveness?.sessionTimeoutMs,
          creation.recoveryTarget?.liveness?.heartbeatTimeoutMs,
          stableDeviceId,
          creation.recoveryTarget?.liveness,
          creation.recoveryTarget?.initialOwnership,
          persistenceSource,
        );
        if (previousSession && platform === "android") {
          this.port.sessionManager.invalidateAutomationReadiness(
            sessionId,
            "same-serial Android device recovery",
          );
        }
        return session;
      };
    }

    if (!allowSessionRebind) {
      return async () => {
        throw new ActionableError(
          `Session '${sessionId}' is already assigned to device '${previousDeviceId}'.`,
        );
      };
    }

    return async () => {
      const previousDevice = this.port.devices.get(previousDeviceId);
      const wasAutolocked = previousDevice?.autolockSessionId === sessionId;
      const replacement = this.port.devices.get(deviceId);
      if (wasAutolocked && holderOf(replacement) === sessionId) {
        replacement!.autolockSessionId = sessionId;
      }
      const session = await this.port.sessionManager.rebindSession(sessionId, deviceId, platform, {
        stableDeviceId,
        deferCleanup: creation.deferCleanup,
      });
      if (previousDevice) {
        this.port.autolockManager.clearRebindAutolockLock(
          sessionId,
          previousDeviceId,
          previousDevice,
        );
      }
      await this.cancelOldDeviceWorkForRebind(previousDeviceId, sessionId);
      await releasePoolDevice(this.port, previousDeviceId, sessionId);
      return session;
    };
  }

  /**
   * Stop work still driving the device a session just left, and wait for it to
   * settle, before the device returns to the pool as idle (#9944). The caller
   * (`setActiveDevice`) is excluded so the rebind does not cancel itself; the
   * injected canceller drains with its own bounded, timer-injected wait.
   */
  private async cancelOldDeviceWorkForRebind(
    previousDeviceId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      // Scoped to this session: another session's or a sessionless read on the
      // still-booted old device must keep running.
      const cancelled =
        (await this.port.cancelDeviceSessionExecutions.cancelDeviceExecutions?.(
          previousDeviceId,
          new ActionableError(
            `Session ${sessionId} was rebound from device '${previousDeviceId}' to another device ` +
              "by setActiveDevice; this call was cancelled because it was still driving the old device.",
          ),
          {
            excludeExecutionId: this.port.ambientExecutionIdReader?.getExecutionId(),
            onlySessionUuid: sessionId,
          },
        )) ?? 0;
      if (cancelled > 0) {
        logger.info(
          `[DevicePool] Cancelled ${cancelled} in-flight execution(s) on ${previousDeviceId} ` +
            `after session ${sessionId} rebound to another device`,
        );
      }
    } catch (error) {
      // Rebind already committed; a failed cancel must not strand the old device.
      logger.warn(
        `[DevicePool] Failed to cancel work on ${previousDeviceId} after rebinding session ${sessionId}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private async reuseExistingDeviceSession(
    deviceId: string,
    existingSession: Session,
    requestedSessionId: string,
    sourceImage?: DeviceInfo,
    confirmedSameOwner = false,
  ): Promise<string> {
    const existingSessionId = existingSession.sessionId;
    if (sourceImage && !confirmedSameOwner) {
      throw freshStartAlreadyBoundError(
        deviceId,
        existingSessionId,
        existingSession.ownership === "awaiting-owner",
        this.port.holderReleaseRemainingMs(existingSessionId),
      );
    }
    // A caller that proved it owns the holder (its MCP connection acquired it) may reuse another
    // session, and so may an anonymous caller when an anonymous acquisition created that session,
    // which keeps repeated `--cli` startDevice idempotent (#2421). Any other anonymous caller is
    // refused rather than handed the holder's UUID (#11071).
    if (
      !confirmedSameOwner &&
      existingSessionId !== requestedSessionId &&
      !isAnonymousAcquisitionSession(existingSession)
    ) {
      throw heldDeviceBindRefusal(this.port, deviceId, existingSessionId, requestedSessionId);
    }
    // The reusing call may already be tracked under the holder (autolock); naming it keeps its
    // own admission from being judged as earlier work still in flight (#11400).
    const refreshedSession = await this.port.sessionManager.getOrCreateSession(
      existingSessionId,
      undefined,
      undefined,
      undefined,
      false,
      { callerExecutionId: this.port.ambientExecutionIdReader?.getExecutionId() },
    );
    logger.info(`Reusing existing session ${refreshedSession.sessionId} for device ${deviceId}`);
    return refreshedSession.sessionId;
  }
}
