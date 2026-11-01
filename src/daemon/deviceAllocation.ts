import { bindDevice, holderOf, isIdle } from "./deviceBinding";
import { DevicePoolError } from "./DevicePoolError";
import type { Mutex } from "async-mutex";
import { ActionableError, type Platform } from "../models";
import { runWithAbortSignal, throwIfRequestAborted } from "../utils/AbortContext";
import type { TTLCache } from "../utils/cache/Cache";
import type { SingleFlight } from "../utils/cache/SingleFlight";
import type { BootedDeviceDiscovery } from "../devices/deviceUtils";
import type { DiscoveryCompleteness } from "../utils/discoverySource";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { RetryExecutor } from "../utils/retry/RetryExecutor";
import type { Timer } from "../utils/SystemTimer";
import type { DeviceAllocationCriteria, DeviceAllocationRequest } from "./DeviceCriteriaMatcher";
import type { DeviceUnhealthyError } from "../models/deviceAcquisitionRefusals";
import { ALLOCATION_SNAPSHOT_STALE_RETRIES, refreshFailureContext } from "./devicePool";
import type {
  DevicePool,
  PooledDevice,
  RollbackAssignment,
  SessionAssignmentSnapshot,
} from "./devicePool";
import type { DevicePoolRefreshResult } from "./devicePoolRefresh";
import type { DeviceRuntimeIdentity } from "./deviceRuntimeIdentity";
import type { EmulatorLossIncident, EmulatorLossIncidentStore } from "./emulatorLossIncident";
import type { EmulatorLossIncidentLedger } from "./emulatorLossIncidentLedger";
import type { ForeignDeviceOwnership } from "./foreignDeviceOwnership";
import type { IdleDeviceReaper, IosLivenessSnapshot } from "./idleDeviceReaper";
import {
  refreshAllocationBindingExclusion,
  type BindingExclusion,
} from "./sessionBroker/provisioning/exclusion";
import type { SessionReleaseReason } from "./releaseReasons";
import {
  SessionRecoveryIdentityLossError,
  type Session,
  type SessionManager,
  type SessionRecoveryTarget,
} from "./sessionManager";

export interface AllocationDiscoverySnapshots {
  capturedEntries: ReadonlySet<PooledDevice>;
  iosLiveness?: IosLivenessSnapshot;
  androidPresence?: BootedDeviceDiscovery;
}

export interface AssignableIdleDeviceSelection {
  device?: PooledDevice;
  livenessUnknown: boolean;
  snapshotStale: boolean;
}

/** Flags for {@link DeviceAllocationPort.ensurePooledDevicePresentForUse}; every field defaults to off. */
export interface PooledDevicePresenceOptions {
  deferRecovery?: boolean;
  assignmentLockHeld?: boolean;
  idleEviction?: boolean;
  discovery?: BootedDeviceDiscovery;
}

export interface DeviceAllocationPort extends Pick<
  DevicePool,
  "getStatsForPlatform" | "releaseRehydrationReservation" | "getDeviceHealthMarker"
> {
  readonly DEVICE_WAIT_TIMEOUT_MS: number;
  readonly DEVICE_WAIT_INTERVAL_MS: number;
  readonly RECOVERY_RESPONSE_MARGIN_MS: number;
  readonly retryExecutor: Pick<RetryExecutor, "execute">;
  readonly emulatorLossIncidentStore: Pick<EmulatorLossIncidentStore, "list">;
  readonly emulatorLossLedger: Pick<EmulatorLossIncidentLedger, "emulatorLossRecoverySettlements">;
  readonly bindingExclusion: Pick<BindingExclusion, "refresh"> | undefined;
  readonly devices: Pick<ReadonlyMap<string, PooledDevice>, "get" | "size">;
  readonly idleDeviceReaper: Pick<
    IdleDeviceReaper,
    "getIosLivenessSnapshot" | "getIdleDeviceLivenessStatus" | "iosDeviceNoun"
  >;
  readonly timer: Timer;
  readonly assignmentMutex: Pick<Mutex, "runExclusive">;
  readonly allocationRefresh: Pick<SingleFlight<"allocation", DevicePoolRefreshResult>, "run">;
  readonly recoveryRetryRefresh: Pick<
    TTLCache<"allocation", DevicePoolRefreshResult>,
    "get" | "set"
  >;
  readonly runtimeIdentity: Pick<DeviceRuntimeIdentity, "isPooledDeviceIdentityAssignable">;
  readonly sessionManager: Pick<SessionManager, "getSession" | "createSession">;
  readonly lastReleasedDeviceId: string | null;
  recoveryNow(): number;
  recoveryAssignmentError(
    sessionId: string,
    target: SessionRecoveryTarget,
    incident?: EmulatorLossIncident,
  ): ActionableError;
  recoveryFailure(
    sessionId: string,
    target: SessionRecoveryTarget,
    refreshCompleteness?: DiscoveryCompleteness,
  ): SessionRecoveryIdentityLossError | DevicePoolError | undefined;
  getDevicesMatchingRecoveryTarget(target: SessionRecoveryTarget): PooledDevice[];
  tracksForeignOwnership(platform?: Platform): boolean;
  getGenericallyAllocatableDevices(platform?: Platform): PooledDevice[];
  hasPendingAndroidRecovery(platform?: Platform): boolean;
  foreignOwnershipFor(platform: Platform | undefined): ForeignDeviceOwnership | undefined;
  isDrivenByForeignDaemon(device: PooledDevice): boolean;
  publishDeviceClaim(deviceId: string): Promise<boolean>;
  assertNotClaimedByForeignDaemon(deviceId: string, platform: Platform): Promise<void>;
  rollbackAssignments(
    assignments: ReadonlyMap<string, RollbackAssignment>,
    releaseReason?: SessionReleaseReason,
  ): Promise<void>;
  refreshForeignOwnership(requireCurrent?: boolean): Promise<void>;
  countForeignDrivenDevices(platform?: Platform): number;
  getUnownedDevicesMatchingCriteria(criteria?: DeviceAllocationCriteria): PooledDevice[];
  hasPendingAndroidRecoveryMatching(criteria?: DeviceAllocationCriteria): boolean;
  shouldValidatePooledDevicePresence(device: PooledDevice): boolean;
  takeFreshPresenceDiscovery(platform: Platform): Promise<BootedDeviceDiscovery>;
  assertHealthyAllocationPossible(
    candidates: readonly PooledDevice[],
    selected: PooledDevice | undefined,
  ): void;
  countBusyDevices(candidates: PooledDevice[]): number;
  shouldWaitForDevice(busyDevices: number, pendingRecovery: boolean): boolean;
  refreshDevicesInternal(assignmentLockHeld: boolean): Promise<DevicePoolRefreshResult>;
  isPooledEntryCurrent(device: PooledDevice): boolean;
  isReservedForAssignment(device: PooledDevice, forSessionId?: string): boolean;
  ensurePooledDevicePresentForUse(
    device: PooledDevice,
    options?: PooledDevicePresenceOptions,
  ): Promise<boolean>;
  unhealthyDevicesError(devices: readonly PooledDevice[]): DeviceUnhealthyError;
  snapshotSessionAssignment(device: PooledDevice): SessionAssignmentSnapshot;
  nextLastUsedAt(): number;
  createSessionOrRestore(
    device: PooledDevice,
    snapshot: SessionAssignmentSnapshot,
    createSession: () => Promise<Session>,
  ): Promise<Session>;
  stableDeviceIdFor(
    device: Pick<PooledDevice, "id" | "name" | "platform" | "avdName" | "identityUnresolved">,
  ): string | undefined;
  restoreSessionAssignment(device: PooledDevice, snapshot: SessionAssignmentSnapshot): void;
  notifyDeviceStateChanged(device: Pick<PooledDevice, "id" | "platform">): void;
  isPotentialAllocationSupply(device: PooledDevice): boolean;
}

/** The recovery a single-attempt assignment serves, and the caller's cancellation. */
export interface AssignFromOptions {
  recoveryTarget?: SessionRecoveryTarget;
  settledRecoveryLoss?: boolean;
  signal?: AbortSignal;
}

export class DeviceAllocation {
  constructor(private readonly port: DeviceAllocationPort) {}

  /**
   * Assign a device to a session
   *
   * Called when a new session is created or when a session needs to pick a device.
   * Returns the device ID assigned to the session.
   *
   * Uses mutex to ensure atomic device assignment and prevent race conditions
   * when multiple tests run in parallel.
   *
   * Automatically refreshes device pool if empty, handling race conditions during
   * daemon startup where device discovery may not have completed.
   *
   * When all devices are busy, waits with timeout for a device to become available.
   * This enables parallel test execution with limited devices.
   */
  async assignDeviceToSession(
    sessionId: string,
    platform?: Platform,
    recoveryTarget?: SessionRecoveryTarget,
    signal?: AbortSignal,
  ): Promise<string> {
    const assignmentSignal = recoveryTarget ? signal : undefined;
    const recoveryDeadline = recoveryTarget?.restartRecoveryDeadlineMs;
    const timeoutMs =
      recoveryDeadline === undefined
        ? this.port.DEVICE_WAIT_TIMEOUT_MS
        : Math.max(0, recoveryDeadline - this.port.recoveryNow());
    // Include the deadline attempt: attempt one runs immediately, before any sleep.
    const maxAttempts = Math.max(
      1,
      Math.ceil(timeoutMs / this.port.DEVICE_WAIT_INTERVAL_MS) +
        (recoveryDeadline === undefined ? 0 : 1),
    );
    let firstAttemptLogged = false;
    let refreshFailure: string | undefined;
    let lossIncident: EmulatorLossIncident | undefined;
    recoveryTarget?.onRecoveryWait?.({
      responseMarginMs: this.port.RECOVERY_RESPONSE_MARGIN_MS,
      restartDeadlineMs: recoveryTarget.restartRecoveryDeadlineMs,
      timeoutError: () =>
        this.port.recoveryAssignmentError(sessionId, recoveryTarget, lossIncident),
    });

    const result = await this.port.retryExecutor.execute(
      async (attempt) => {
        // Ordinary allocation must capture candidates before yielding to release/readiness.
        if (recoveryTarget) {
          lossIncident = await this.settledRecoveryLossIncident(sessionId, recoveryTarget);
        }
        // Try to assign device (mutex ensures atomic assignment)
        const assignResult = await this.tryAssignDevice(sessionId, {
          platform,
          recoveryTarget,
          settledRecoveryLoss: lossIncident !== undefined,
          signal,
        });
        if (assignResult.refreshCompleted) {
          refreshFailure = assignResult.refreshFailure;
        }

        if (assignResult.success) {
          if (attempt > 1) {
            logger.info(
              `Device ${assignResult.deviceId} assigned to session ${sessionId} ` +
                `after ${attempt} attempts`,
            );
          }
          return assignResult.deviceId!;
        }

        if (recoveryTarget) {
          lossIncident = await this.checkRecoveryAssignmentFailure(
            sessionId,
            recoveryTarget,
            assignResult.refreshCompleteness,
            lossIncident,
          );
        }

        // No device available - check if we should wait or fail
        if (assignResult.livenessUnknown) {
          throw new DevicePoolError(
            `Unable to verify iOS simulator liveness for session ${sessionId}; iOS discovery failed.`,
            false,
          );
        }
        if (assignResult.shouldWait) {
          // Devices exist but are busy - throw retryable error
          if (!firstAttemptLogged) {
            firstAttemptLogged = true;
            logger.info(
              `All ${assignResult.totalDevices} devices busy, ` +
                `session ${sessionId} waiting for availability (timeout: ${timeoutMs / 1000}s)...`,
            );
          }
          throw new DevicePoolError("All devices busy", true, refreshFailure);
        } else {
          // No devices at all - fail immediately with non-retryable error
          const stats = this.port.getStatsForPlatform(platform);
          throw new DevicePoolError(
            `No devices in pool to assign to session ${sessionId}.\n` +
              `Device pool status:\n` +
              `  Total devices: ${stats.total}\n` +
              `  Idle: ${stats.idle}\n` +
              `  Assigned: ${stats.assigned}\n` +
              `  Error: ${stats.error}\n\n` +
              `Suggestions:\n` +
              `  - Start an emulator or connect a physical device\n` +
              `  - Check device pool status: auto-mobile --cli listDevices\n` +
              `  - Verify device tooling is working for the selected platform`,
            false,
          );
        }
      },
      this.assignmentRetryPolicy(maxAttempts, assignmentSignal, recoveryDeadline),
    );

    if (!result.success) {
      this.throwSessionAssignmentFailure({
        sessionId,
        platform,
        recoveryTarget,
        error: result.error,
        attempts: result.attempts,
        timeoutMs,
        lossIncident,
      });
    }

    return result.value!;
  }

  /**
   * How `assignDeviceToSession` waits for a busy pool: retry retryable pool errors every wait
   * interval, and for a restart recovery only until its deadline. The deadline derives from session
   * stamps, so both the wait and the retry gate read the session clock a wall-clock step does not
   * move (#11105, #11162).
   */
  private assignmentRetryPolicy(
    maxAttempts: number,
    signal: AbortSignal | undefined,
    recoveryDeadline: number | undefined,
  ): NonNullable<Parameters<RetryExecutor["execute"]>[1]> {
    return {
      maxAttempts,
      signal,
      delays: () =>
        Math.min(
          this.port.DEVICE_WAIT_INTERVAL_MS,
          recoveryDeadline === undefined
            ? this.port.DEVICE_WAIT_INTERVAL_MS
            : Math.max(0, recoveryDeadline - this.port.recoveryNow()),
        ),
      shouldRetry: (error) =>
        error instanceof DevicePoolError &&
        error.isRetryable &&
        (recoveryDeadline === undefined || this.port.recoveryNow() < recoveryDeadline),
    };
  }

  private throwSessionAssignmentFailure({
    sessionId,
    platform,
    recoveryTarget,
    error,
    attempts,
    timeoutMs,
    lossIncident,
  }: {
    sessionId: string;
    platform?: Platform;
    recoveryTarget?: SessionRecoveryTarget;
    error?: Error;
    attempts: number;
    timeoutMs: number;
    lossIncident?: EmulatorLossIncident;
  }): never {
    if (recoveryTarget && error instanceof DevicePoolError) {
      throw this.port.recoveryAssignmentError(sessionId, recoveryTarget, lossIncident);
    }
    // Check if it was a non-retryable error (no devices)
    if (error instanceof DevicePoolError && !error.isRetryable) {
      throw new ActionableError(error.message);
    }
    if (error && !(error instanceof DevicePoolError && error.isRetryable)) {
      throw error;
    }
    // Timeout case - all attempts exhausted
    const stats = this.port.getStatsForPlatform(platform);
    throw new ActionableError(
      `Timed out waiting for device after ${Math.round(timeoutMs / 1000)}s (${attempts} attempts).\n` +
        refreshFailureContext(error) +
        `Session: ${sessionId}\n` +
        `Device pool status:\n` +
        `  Total devices: ${stats.total}\n` +
        `  Idle: ${stats.idle}\n` +
        `  Assigned: ${stats.assigned}\n` +
        `  Error: ${stats.error}\n\n` +
        `Suggestions:\n` +
        `  - Reduce parallel test count to match available devices\n` +
        `  - Start additional emulators or connect more physical devices\n` +
        `  - Check if tests are properly releasing devices after completion`,
    );
  }

  private async checkRecoveryAssignmentFailure(
    sessionId: string,
    target: SessionRecoveryTarget,
    refreshCompleteness: DiscoveryCompleteness | undefined,
    incident: EmulatorLossIncident | undefined,
  ): Promise<EmulatorLossIncident | undefined> {
    // Loss can settle while discovery is in flight. Re-read diagnostics before
    // deciding whether this attempt should report pending.
    incident ??= await this.settledRecoveryLossIncident(sessionId, target);
    const failure = this.port.recoveryFailure(sessionId, target, refreshCompleteness);
    // Duplicate exact identities stay terminal. Serial reuse means absence during
    // a restart handoff, including its absent-target answer after expiry.
    if (failure instanceof SessionRecoveryIdentityLossError) {
      // Persisted-only terminalization does not notify the live-session release listener.
      this.port.releaseRehydrationReservation(sessionId, true);
      throw failure;
    }
    // Reading diagnostics or discovery can cross the restart deadline. Only
    // recoveryFailure may decide absence once that window closes.
    if (
      incident &&
      target.restartRecoveryDeadlineMs !== undefined &&
      this.port.recoveryNow() < target.restartRecoveryDeadlineMs &&
      this.port.getDevicesMatchingRecoveryTarget(target).length === 0
    ) {
      throw this.port.recoveryAssignmentError(sessionId, target, incident);
    }
    if (failure) {
      throw failure;
    }
    return incident;
  }

  private async settledRecoveryLossIncident(
    sessionId: string,
    target: SessionRecoveryTarget,
  ): Promise<EmulatorLossIncident | undefined> {
    if (
      target.platform !== "android" ||
      target.restartRecoveryDeadlineMs === undefined ||
      this.port.recoveryNow() >= target.restartRecoveryDeadlineMs
    ) {
      return undefined;
    }
    try {
      const incident = (await this.port.emulatorLossIncidentStore.list()).find(
        (candidate) =>
          candidate.session?.sessionUuid === sessionId &&
          candidate.deviceId === target.deviceId &&
          (candidate.detectionPath !== "serial-reuse" ||
            candidate.session.state === "awaiting-device") &&
          (candidate.avdName === undefined || candidate.avdName === target.stableDeviceId),
      );
      return incident &&
        !this.port.emulatorLossLedger.emulatorLossRecoverySettlements.has(incident.id) &&
        (incident.recovery.outcome === "not-attempted" || incident.recovery.outcome === "exhausted")
        ? incident
        : undefined;
    } catch (error) {
      // Diagnostics failure must not replace the bounded recovery error.
      logger.warn("[DevicePool] Failed to read recovery loss incident", error);
      return undefined;
    }
  }

  /**
   * Try to assign a device to a session (single attempt)
   *
   * Returns success status and whether caller should wait and retry.
   */
  async tryAssignDevice(
    sessionId: string,
    {
      platform,
      recoveryTarget,
      settledRecoveryLoss,
      signal,
    }: {
      platform?: Platform;
      recoveryTarget?: SessionRecoveryTarget;
      settledRecoveryLoss?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<{
    success: boolean;
    deviceId?: string;
    session?: Session;
    shouldWait: boolean;
    totalDevices: number;
    livenessUnknown?: boolean;
    refreshCompleteness?: DiscoveryCompleteness;
    refreshFailure?: string;
    refreshCompleted?: boolean;
  }> {
    if (!recoveryTarget && this.port.bindingExclusion) {
      // Guarded, not awaited unconditionally: an extra tick reorders allocation interleavings.
      await refreshAllocationBindingExclusion(this.port.bindingExclusion);
    }
    if (!recoveryTarget && this.port.tracksForeignOwnership(platform)) {
      return this.tryAssignUnclaimedDevice(sessionId, platform, signal);
    }
    if (!recoveryTarget) {
      // A pool built without ownership tracking (tests) publishes no claims.
      return this.tryAssignFrom(
        sessionId,
        () => this.port.getGenericallyAllocatableDevices(platform),
        "platform pool empty",
        { hasPendingRecovery: () => this.port.hasPendingAndroidRecovery(platform), signal },
      );
    }
    const ownership = this.port.foreignOwnershipFor(recoveryTarget.platform);
    if (ownership) {
      await this.assertRecoveryTargetNotForeignOwned(recoveryTarget);
    }
    const result = await this.tryAssignFrom(
      sessionId,
      () => this.port.getDevicesMatchingRecoveryTarget(recoveryTarget),
      "recovery target pool empty",
      {
        hasPendingRecovery: () => this.port.hasPendingAndroidRecovery(platform),
        recoveryTarget,
        settledRecoveryLoss,
        signal,
      },
    );
    if (ownership && result.success && result.deviceId !== undefined && result.session) {
      await this.claimRecoveredDevice(sessionId, recoveryTarget, ownership, {
        deviceId: result.deviceId,
        session: result.session,
      });
    }
    return result;
  }

  /**
   * A restarted daemon must not rehydrate a session onto a device another live daemon took over
   * while it was down (#11076, #15738). Only the devices the target resolves to now are checked:
   * its persisted serial may name another AVD today. An empty pool is checked again after discovery,
   * before binding (see the caller).
   */
  private async assertRecoveryTargetNotForeignOwned(target: SessionRecoveryTarget): Promise<void> {
    const idle = this.port
      .getDevicesMatchingRecoveryTarget(target)
      .filter((device) => holderOf(device) === null);
    for (const { id: deviceId } of idle) {
      // Use the explicit-bind judgement: files first, then the table, with a fresh read.
      await this.port.assertNotClaimedByForeignDaemon(deviceId, target.platform);
    }
  }

  /**
   * Publish this daemon's claim on the device recovery just rebound. When another live daemon's
   * claim won the race, give the device back and terminalize the session (#11076).
   */
  private async claimRecoveredDevice(
    sessionId: string,
    target: SessionRecoveryTarget,
    ownership: ForeignDeviceOwnership,
    { deviceId, session }: { deviceId: string; session: Session },
  ): Promise<void> {
    if (await this.port.publishDeviceClaim(deviceId)) {
      return;
    }
    logger.warn(
      `[DevicePool] Another AutoMobile process (PID ${ownership.foreignOwnerPid(deviceId)}) claims ${deviceId}; rolling back recovery of session ${sessionId}`,
    );
    await this.port.rollbackAssignments(new Map([[sessionId, { deviceId, session }]]));
    // Rollback cleared the local holder, so the fresh explicit-bind refusal can name the winner.
    await this.port.assertNotClaimedByForeignDaemon(deviceId, target.platform);
    throw new SessionRecoveryIdentityLossError(sessionId, target, "owned-by-other-daemon", {
      deviceId,
      ownerPid: ownership.foreignOwnerPid(deviceId),
    });
  }

  /**
   * Single-device attempt (#10709): skip devices another live daemon drives, and publish this
   * daemon's claim on the assigned device so other daemons see the session before any CtrlProxy
   * forward exists. While only other daemons' devices are left, wait as for a busy device.
   */
  private async tryAssignUnclaimedDevice(
    sessionId: string,
    platform?: Platform,
    signal?: AbortSignal,
  ): ReturnType<DeviceAllocation["tryAssignDevice"]> {
    await this.port.refreshForeignOwnership();
    const result = await this.tryAssignUnownedDevice(sessionId, platform, signal);
    if (
      !result.success &&
      !result.shouldWait &&
      !result.livenessUnknown &&
      this.port.countForeignDrivenDevices(platform) > 0
    ) {
      return { ...result, shouldWait: true };
    }
    return result;
  }

  /** Platform multi-device attempt: like tryAssignDevice, minus devices other daemons drive. */
  async tryAssignUnownedDevice(
    sessionId: string,
    platform?: Platform,
    signal?: AbortSignal,
  ): ReturnType<DeviceAllocation["tryAssignDevice"]> {
    return this.claimAssignedDevice(
      sessionId,
      await this.tryAssignFrom(
        sessionId,
        () =>
          this.port
            .getGenericallyAllocatableDevices(platform)
            .filter((device) => !this.port.isDrivenByForeignDaemon(device)),
        "platform pool empty",
        { hasPendingRecovery: () => this.port.hasPendingAndroidRecovery(platform), signal },
      ),
    );
  }

  /**
   * Publish this daemon's claim on an Android device multi-device allocation just assigned, so
   * another daemon's allocation sees it before any CtrlProxy forward exists. When another daemon
   * claimed it first and still uses it, give the device back and wait like a busy device.
   */
  private async claimAssignedDevice(
    sessionId: string,
    result: Awaited<ReturnType<DeviceAllocation["tryAssignFrom"]>>,
  ): Promise<Awaited<ReturnType<DeviceAllocation["tryAssignFrom"]>>> {
    const deviceId = result.deviceId;
    if (
      !result.success ||
      deviceId === undefined ||
      !result.session ||
      !this.port.foreignOwnershipFor(this.port.devices.get(deviceId)?.platform)
    ) {
      return result;
    }
    if (await this.port.publishDeviceClaim(deviceId)) {
      return result;
    }
    logger.info(
      `[DevicePool] Another AutoMobile process claimed ${deviceId} first; releasing it from session ${sessionId}`,
    );
    await this.port.rollbackAssignments(
      new Map([[sessionId, { deviceId, session: result.session }]]),
    );
    return { ...result, success: false, deviceId: undefined, session: undefined, shouldWait: true };
  }

  recordCriteriaAssignment(
    request: DeviceAllocationRequest,
    result: Awaited<ReturnType<DeviceAllocation["tryAssignDeviceWithCriteria"]>>,
    assignments: Map<string, string>,
    assignmentsToRollback: Map<string, RollbackAssignment>,
  ): void {
    assignments.set(request.sessionId, result.deviceId!);
    if (result.session) {
      assignmentsToRollback.set(request.sessionId, {
        deviceId: result.deviceId!,
        session: result.session,
      });
    }
  }

  async tryAssignDeviceWithCriteria(
    sessionId: string,
    criteria?: DeviceAllocationCriteria,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    deviceId?: string;
    session?: Session;
    shouldWait: boolean;
    totalDevices: number;
    livenessUnknown?: boolean;
    refreshCompleteness?: DiscoveryCompleteness;
    refreshFailure?: string;
    refreshCompleted?: boolean;
  }> {
    return this.claimAssignedDevice(
      sessionId,
      await this.tryAssignFrom(
        sessionId,
        () => this.port.getUnownedDevicesMatchingCriteria(criteria),
        "criteria pool empty",
        { hasPendingRecovery: () => this.port.hasPendingAndroidRecoveryMatching(criteria), signal },
      ),
    );
  }

  /** Capture idle entries before taking one fresh sweep per platform outside the assignment lock. */
  private async takeAllocationSnapshots(
    candidates: PooledDevice[],
    signal?: AbortSignal,
  ): Promise<AllocationDiscoverySnapshots> {
    // Only entries idle before discovery may be judged by this pass. A newly
    // released, added or replaced entry needs its own fresh snapshot.
    const capturedEntries = new Set(candidates.filter((device) => isIdle(device)));
    const [iosLiveness, androidPresence, tvosLiveness] = await raceWithDeadline(
      () =>
        Promise.all([
          candidates.some((device) => isIdle(device) && device.platform === "ios")
            ? this.port.idleDeviceReaper.getIosLivenessSnapshot()
            : undefined,
          candidates.some(
            (device) => isIdle(device) && this.port.shouldValidatePooledDevicePresence(device),
          )
            ? this.port.takeFreshPresenceDiscovery("android")
            : undefined,
          candidates.some((device) => isIdle(device) && device.platform === "tvos")
            ? this.port.idleDeviceReaper.getIosLivenessSnapshot({ platform: "tvos" })
            : undefined,
        ]),
      { timer: this.port.timer, signal, label: "Device allocation discovery" },
    );
    if (iosLiveness && tvosLiveness) {
      iosLiveness.tvosDiscoverySucceeded = tvosLiveness.tvosDiscoverySucceeded;
      for (const id of tvosLiveness.bootedDeviceIds) {
        iosLiveness.bootedDeviceIds.add(id);
      }
    }
    return {
      capturedEntries,
      iosLiveness: iosLiveness ?? tvosLiveness,
      androidPresence,
    };
  }

  /**
   * Shared single-attempt assignment body for platform- and criteria-based
   * allocation. Parameterized only by how candidate devices are selected and
   * the label used when the candidate pool is empty.
   *
   * Selection order: prefer the most recently released device for reuse, then
   * fall back to the least-recently-used idle device for load distribution.
   *
   * @param emptyCandidatePoolReason label logged when candidates exist in the
   *   pool overall but none match this selector (the `totalDevices === 0` case)
   */
  async tryAssignFrom(
    sessionId: string,
    selectCandidates: () => PooledDevice[],
    emptyCandidatePoolReason: string,
    { hasPendingRecovery, ...options }: AssignFromOptions & { hasPendingRecovery: () => boolean },
  ): Promise<{
    success: boolean;
    deviceId?: string;
    session?: Session;
    shouldWait: boolean;
    totalDevices: number;
    livenessUnknown?: boolean;
    refreshCompleteness?: DiscoveryCompleteness;
    refreshFailure?: string;
    refreshCompleted?: boolean;
  }> {
    const { recoveryTarget, settledRecoveryLoss = false, signal } = options;
    let livenessUnknown = false;
    let refreshCompleteness: DiscoveryCompleteness | undefined;
    let refreshFailure: string | undefined;
    let refreshCompleted = false;
    let refreshed = false;
    let refreshInconclusive = false;
    let staleRetries = 0;

    while (true) {
      throwIfRequestAborted();
      const candidatesBeforeDiscovery = selectCandidates();
      const snapshots = await this.takeAllocationSnapshots(candidatesBeforeDiscovery, signal);

      if (recoveryTarget && this.port.foreignOwnershipFor(recoveryTarget.platform)) {
        // Discovery may have added the target or its owner may have changed since preflight.
        // Check before binding: once held locally the explicit-bind guard intentionally skips it.
        await this.assertRecoveryTargetNotForeignOwned(recoveryTarget);
      }

      // Platform snapshots and refresh discovery are outside this boundary.
      // In-memory validation and short local DB/incident-ledger writes stay inside.
      // Shared identity reconciliation retains its bounded unreadable-AVD retries:
      // splitting its confirmed-identity/quarantine transition needs its own fence.
      const result = await this.port.assignmentMutex.runExclusive(async () => {
        throwIfRequestAborted();
        let candidates = selectCandidates();
        let selection = await this.selectAssignableIdleDevice(candidates, snapshots, sessionId);
        let device = selection.device;
        let snapshotStale = selection.snapshotStale;
        livenessUnknown ||= selection.livenessUnknown;
        candidates = selectCandidates();

        // Selection can await local persistence, and release does not take this
        // mutex. Revalidate after that await; skip invalid entries without I/O.
        while (device && !this.isCurrentIdleDeviceAssignable(device, sessionId)) {
          snapshotStale = true;
          candidates = candidates.filter((candidate) => candidate !== device);
          selection = await this.selectAssignableIdleDevice(candidates, snapshots, sessionId);
          device = selection.device;
          livenessUnknown ||= selection.livenessUnknown;
        }

        if (device) {
          const totalDevices = selectCandidates().length;
          // No await between the final validation above and claim's field writes.
          const assignment = await this.claimSelectedDeviceForSession(
            sessionId,
            device,
            recoveryTarget,
            signal,
          );
          logger.info(`Assigned device ${device.id} to session ${sessionId}`);
          return {
            success: true,
            deviceId: assignment.deviceId,
            session: assignment.session,
            shouldWait: false,
            totalDevices,
            shouldRefresh: false,
            snapshotStale,
          };
        }

        candidates = selectCandidates();
        const totalDevices = candidates.length;
        this.port.assertHealthyAllocationPossible(candidates, device);
        const busyDevices = this.port.countBusyDevices(candidates);
        const shouldRefresh =
          !refreshed && (this.port.devices.size === 0 || totalDevices === 0 || busyDevices === 0);
        if (shouldRefresh) {
          const refreshReason =
            this.port.devices.size === 0
              ? "empty pool"
              : totalDevices === 0
                ? emptyCandidatePoolReason
                : "no idle usable devices";
          logger.info(`[DevicePool] Auto-refreshing devices due to ${refreshReason}...`);
        }
        return {
          success: false,
          shouldWait: this.port.shouldWaitForDevice(busyDevices, hasPendingRecovery()),
          totalDevices,
          livenessUnknown,
          refreshCompleteness,
          shouldRefresh,
          snapshotStale,
        };
      });
      const { shouldRefresh, snapshotStale, ...assignment } = result;
      if (assignment.success) {
        return { ...assignment, refreshCompleteness, refreshFailure, refreshCompleted };
      }
      if (shouldRefresh) {
        refreshed = true;
        // Allocation waiters share discovery outside the mutex. The shared task
        // must not inherit one caller's cancellation; each waiter can stop alone.
        const refreshResult = await this.port.allocationRefresh.run(
          "allocation",
          () => this.refreshForAllocation(recoveryTarget, settledRecoveryLoss),
          signal,
        );
        refreshCompleteness = refreshResult.completeness;
        refreshFailure = refreshResult.failure;
        // Discarded discovery is neither a failure nor a successful refresh.
        refreshCompleted = refreshFailure !== undefined || refreshCompleteness !== undefined;
        // A background refresh can still supersede this flight. Its discarded
        // result (or failed discovery) cannot establish authoritative absence,
        // including for exact recovery targets; let the public retry bound it.
        refreshInconclusive = refreshCompleteness === undefined;
        continue;
      }
      if (refreshInconclusive) {
        return {
          ...assignment,
          shouldWait: true,
          refreshCompleteness,
          refreshFailure,
          refreshCompleted,
        };
      }
      if (!snapshotStale) {
        return { ...assignment, refreshCompleteness, refreshFailure, refreshCompleted };
      }
      if (staleRetries++ >= ALLOCATION_SNAPSHOT_STALE_RETRIES) {
        // Let the existing allocation timeout/retry loop bound sustained churn.
        return {
          ...assignment,
          shouldWait: true,
          refreshCompleteness,
          refreshFailure,
          refreshCompleted,
        };
      }
    }
  }

  private refreshForAllocation(
    target: SessionRecoveryTarget | undefined,
    settledRecoveryLoss: boolean,
  ): Promise<DevicePoolRefreshResult> {
    return runWithAbortSignal(undefined, () =>
      target
        ? this.refreshForRecoveryRetry(target, settledRecoveryLoss)
        : this.port.refreshDevicesInternal(false),
    );
  }

  private async refreshForRecoveryRetry(
    target: SessionRecoveryTarget,
    settledRecoveryLoss: boolean,
  ): Promise<DevicePoolRefreshResult> {
    if (
      target.restartRecoveryDeadlineMs === undefined ||
      this.port.recoveryNow() >= target.restartRecoveryDeadlineMs
    ) {
      return this.port.refreshDevicesInternal(false);
    }
    // Pool-wide, not per session: multiple recovering sessions must not each
    // spend a miss against the same bystander. Ordinary refreshes are not cached
    // here, so the first recovery retry still discovers after the loss.
    // Only the settled-loss fast pending error enables cache reuse. Unsettled
    // recovery retains its existing in-call polling and caller deadlines.
    const recent = settledRecoveryLoss
      ? this.port.recoveryRetryRefresh.get("allocation")
      : undefined;
    if (recent) {
      return recent;
    }
    const result = await this.port.refreshDevicesInternal(false);
    // Cache even inconclusive results to bound retries during discovery failure.
    // SingleFlight owns this task independently of each caller's cancellation.
    this.port.recoveryRetryRefresh.set("allocation", result);
    return result;
  }

  // selectAssignableIdleDevice additionally requires eligibility and resolved identity.
  isCurrentIdleDeviceAssignable(device: PooledDevice, forSessionId?: string): boolean {
    return (
      this.port.isPooledEntryCurrent(device) &&
      holderOf(device) === null &&
      this.selectIdleDevice([device], forSessionId) === device &&
      this.port.runtimeIdentity.isPooledDeviceIdentityAssignable(device)
    );
  }

  async selectAssignableIdleDevice(
    candidates: PooledDevice[],
    { capturedEntries, iosLiveness, androidPresence }: AllocationDiscoverySnapshots,
    forSessionId?: string,
  ): Promise<AssignableIdleDeviceSelection> {
    let device = this.selectIdleDevice(candidates, forSessionId);
    let livenessUnknown = false;
    let snapshotStale = [...capturedEntries].some(
      (entry) =>
        !this.port.isPooledEntryCurrent(entry) ||
        !isIdle(entry) ||
        holderOf(entry) !== null ||
        this.port.isReservedForAssignment(entry, forSessionId),
    );
    // One fresh Android sweep per pass (#6546), now taken outside the mutex.
    // Entry identity fences older snapshots from newer pool incarnations (#8130).
    while (device) {
      const skippedDeviceId = device.id;
      if (!capturedEntries.has(device)) {
        snapshotStale = true;
      } else if (!this.port.runtimeIdentity.isPooledDeviceIdentityAssignable(device)) {
        // Quarantined serial identity is not assignable, even if it is present.
      } else if (!this.isCurrentIdleDeviceAssignable(device, forSessionId)) {
        snapshotStale = true;
      } else if (this.port.shouldValidatePooledDevicePresence(device)) {
        if (!androidPresence) {
          // An entry that became idle after discovery needs a fresh pass.
          snapshotStale = true;
        } else if (!androidPresence.devices.some((booted) => booted.deviceId === skippedDeviceId)) {
          // Pre-lock absence may already be stale on this same entry. Skip it;
          // fenced refresh/monitor miss thresholds alone own missing eviction.
          snapshotStale = true;
        } else if (
          await this.port.ensurePooledDevicePresentForUse(device, {
            deferRecovery: true,
            assignmentLockHeld: true,
            discovery: androidPresence,
          })
        ) {
          return { device, livenessUnknown, snapshotStale };
        } else {
          // Reconciliation may have removed or replaced this captured entry.
          // A replacement needs its own pass before it can be handed out.
          snapshotStale ||= !this.port.isPooledEntryCurrent(device);
        }
      } else {
        const status = this.port.idleDeviceReaper.getIdleDeviceLivenessStatus(device, iosLiveness);
        if (status === "assignable") {
          return { device, livenessUnknown, snapshotStale };
        }
        if (status === "stale") {
          // As with Android, absence before the lock cannot retire this entry.
          snapshotStale = true;
        } else {
          livenessUnknown = true;
          logger.warn(
            `[DevicePool] Cannot assign idle iOS ${this.port.idleDeviceReaper.iosDeviceNoun(device.id)} ${device.id}: ` +
              "its iOS liveness discovery source failed",
          );
        }
      }
      candidates = candidates.filter((candidate) => candidate.id !== skippedDeviceId);
      device = this.selectIdleDevice(candidates, forSessionId);
    }
    return { livenessUnknown, snapshotStale };
  }

  private async claimSelectedDeviceForSession(
    sessionId: string,
    device: PooledDevice,
    recoveryTarget?: SessionRecoveryTarget,
    signal?: AbortSignal,
  ): Promise<{ deviceId: string; session?: Session }> {
    // Recovery deadline cancellation must fence the claim's synchronous field writes.
    if (recoveryTarget) {
      throwIfRequestAborted();
    }
    if (this.port.getDeviceHealthMarker(device.id)) {
      throw this.port.unhealthyDevicesError([device]);
    }
    const existingSession = this.port.sessionManager.getSession(sessionId);
    const assignmentSnapshot = this.port.snapshotSessionAssignment(device);
    bindDevice(device, sessionId);
    device.lastUsedAt = this.port.nextLastUsedAt();
    device.assignmentCount++;
    device.errorCount = 0;
    if (recoveryTarget?.persistenceMetadata?.autolockEnabled) {
      device.autolockSessionId = sessionId;
    }
    const session = await this.port.createSessionOrRestore(device, assignmentSnapshot, () =>
      this.port.sessionManager.createSession(sessionId, device.id, device.platform, {
        timeoutMs: recoveryTarget?.liveness?.sessionTimeoutMs,
        heartbeatTimeoutMs: recoveryTarget?.liveness?.heartbeatTimeoutMs,
        stableDeviceId: this.port.stableDeviceIdFor(device),
        recoveredLiveness: recoveryTarget?.liveness,
        initialOwnership: recoveryTarget?.initialOwnership,
        signal,
      }),
    );
    if (session.assignedDevice !== device.id) {
      this.port.restoreSessionAssignment(device, assignmentSnapshot);
      return { deviceId: session.assignedDevice };
    }
    this.port.notifyDeviceStateChanged(device);
    return existingSession === session ? { deviceId: device.id } : { deviceId: device.id, session };
  }

  isIdleDeviceEligible(device: PooledDevice, forSessionId?: string): boolean {
    return (
      isIdle(device) &&
      this.port.isPotentialAllocationSupply(device) &&
      !this.port.isReservedForAssignment(device, forSessionId)
    );
  }

  selectIdleDevice(candidates: PooledDevice[], forSessionId?: string): PooledDevice | undefined {
    // Find idle devices and prefer most recently released for reuse
    const idleDevices = candidates.filter((device) =>
      this.isIdleDeviceEligible(device, forSessionId),
    );
    if (idleDevices.length === 0) {
      return undefined;
    }

    if (this.port.lastReleasedDeviceId) {
      const lastReleased = idleDevices.find((d) => d.id === this.port.lastReleasedDeviceId);
      if (lastReleased) {
        return lastReleased;
      }
    }

    // Sort by lastUsedAt (ascending) to get least recently used device.
    // This provides better load distribution across devices.
    idleDevices.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    return idleDevices[0];
  }
}
