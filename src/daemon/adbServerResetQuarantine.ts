import type { Mutex } from "async-mutex";
import { ActionableError, type DeviceInfo } from "../models";
import type { Session, SessionManager } from "./sessionManager";
import type { DeviceRecoveryCoordinator } from "./deviceRecoveryCoordinator";
import type {
  AndroidRecoveryRecord,
  AndroidRecoveryReservationKind,
} from "./androidRecoveryRecordLedger";
import { deviceLossCancellationReason } from "./emulatorLossIncident";
import type {
  AdbServerResetCohortDetachment,
  AdbServerResetRecoveryReservation,
  AndroidStartupLeaseRequest,
  DeviceAutolockChildProcess,
  PooledDevice,
} from "./devicePool";

export interface AdbServerResetQuarantinePoolPort {
  getAssignmentMutex(): Mutex;
  getDevices(): Map<string, PooledDevice>;
  getSessionManager(): SessionManager;
  getStartedDeviceProcesses(): Map<string, DeviceAutolockChildProcess>;
  getAdbServerResetTrackedProcesses(): WeakMap<PooledDevice, DeviceAutolockChildProcess>;
  getAdbServerResetRecoveryReservations(): Map<string, AdbServerResetRecoveryReservation>;
  getAndroidStartupLeases(): Map<symbol, AndroidStartupLeaseRequest>;
  getRecoveringAndroidImages(): Map<string, DeviceInfo>;
  getRecoveringAndroidDeviceIds(): Set<string>;
  getRecoveringSessionLosses(): Map<string, AndroidRecoveryRecord>;
  getFailedTerminalRecoveryReleases(): Set<string>;
  getRecoveryCoordinator(): DeviceRecoveryCoordinator;
  getAfterAndroidStartupRecoverySnapshot(): (() => void) | undefined;
  getDevice(id: string): PooledDevice | null;
  isPreservedSessionCurrent(session: Session, deviceId: string): boolean;
  isAndroidEmulatorActiveRelaunchEligible(
    device: PooledDevice,
  ): device is PooledDevice & { avdName: string; androidImage: DeviceInfo };
  removeDevice(id: string, awaitCacheCleanup: boolean, expectedDevice: PooledDevice): Promise<void>;
  startAndroidRecoveryRecord(
    sessionId: string,
    details: Omit<
      Partial<AndroidRecoveryRecord>,
      "sessionId" | "generation" | "state" | "reservations"
    >,
    reservations: readonly AndroidRecoveryReservationKind[],
    replace?: boolean,
  ): AndroidRecoveryRecord;
  recordEmulatorLossIncident(
    deviceId: string,
    path: "adb-server-reset",
    processExit: undefined,
    lastAdbState: "absent",
  ): Promise<string | undefined>;
  cancelDeviceExecutions(deviceId: string, reason: string): Promise<number>;
  cancelDeviceSessionExecutions(sessionId: string, reason: string): Promise<number>;
  completeEmulatorLossRecovery(
    incidentId: string,
    outcome: "exhausted" | "not-attempted",
  ): Promise<void>;
  settleEmulatorLossIncident(incidentId: string): void;
  finishEmulatorLossIncident(incidentId: string, outcome: "not-attempted"): Promise<void>;
  stopTrackedEmulatorProcess(id: string): Promise<void>;
}

/** Serializes reset cohort detachment and startup fences against live pool state. */
export class AdbServerResetQuarantine {
  constructor(private readonly pool: AdbServerResetQuarantinePoolPort) {}

  getAdbResetRecoveryDevice(
    deviceId: string,
    expectedDevice: PooledDevice | undefined,
  ): (PooledDevice & { avdName: string; androidImage: DeviceInfo }) | undefined {
    const currentDevice = this.pool.getDevices().get(deviceId);
    if (currentDevice === undefined) {
      return expectedDevice && this.pool.isAndroidEmulatorActiveRelaunchEligible(expectedDevice)
        ? expectedDevice
        : undefined;
    }
    if (expectedDevice !== undefined && currentDevice !== expectedDevice) {
      // A preceding cohort member can legitimately reuse this detached
      // member's old serial. Keep recovering the captured AVD by its stable
      // name rather than treating that different replacement as this device.
      return this.pool.isAndroidEmulatorActiveRelaunchEligible(expectedDevice)
        ? expectedDevice
        : undefined;
    }
    return this.pool.isAndroidEmulatorActiveRelaunchEligible(currentDevice)
      ? currentDevice
      : undefined;
  }

  getAdbResetRecoverySession(device: PooledDevice): Session | undefined {
    if (device.adbServerResetSession) {
      return this.pool.isPreservedSessionCurrent(device.adbServerResetSession, device.id)
        ? device.adbServerResetSession
        : undefined;
    }
    const sessionId =
      device.adbServerResetSessionId ??
      device.sessionId ??
      this.pool.getSessionManager().getSessionForDevice(device.id);
    const session = sessionId ? this.pool.getSessionManager().getSession(sessionId) : null;
    if (!session || session.assignedDevice !== device.id || session.platform !== "android") {
      return undefined;
    }
    return session;
  }

  async detachAdbServerResetCohort(
    cohort: readonly PooledDevice[],
  ): Promise<AdbServerResetCohortDetachment> {
    return await this.pool.getAssignmentMutex().runExclusive(async () => {
      if (
        cohort.some(
          (device) =>
            this.pool.isAndroidEmulatorActiveRelaunchEligible(device) &&
            this.isLeasedForAndroidStartup(device.avdName),
        )
      ) {
        // An ADB reset affects every member of this captured cohort. Leaving a
        // subset pooled would make later polling treat those members as ordinary
        // disconnects, permanently separating their preserved sessions.
        return { devices: [], deferred: true };
      }
      await this.prepareAdbServerResetCohortDetachment(cohort);
      const detached: PooledDevice[] = [];
      for (const device of cohort) {
        if (
          this.pool.getDevices().get(device.id) !== device ||
          !this.pool.isAndroidEmulatorActiveRelaunchEligible(device)
        ) {
          continue;
        }
        const sessionId = device.sessionId;
        if (device.sessionId) {
          const session = this.pool.getSessionManager().getSession(device.sessionId);
          if (!session || session.assignedDevice !== device.id || session.platform !== "android") {
            this.pool.getRecoveryCoordinator().finalizeRecoveryRecord(device.sessionId);
            continue;
          }
          device.adbServerResetSessionId = device.sessionId;
        }
        device.adbServerResetAutolockSessionId = device.autolockSessionId;
        const trackedProcess = this.pool.getStartedDeviceProcesses().get(device.id);
        if (trackedProcess && sessionId) {
          this.pool.getAdbServerResetTrackedProcesses().set(device, trackedProcess);
        }
        this.reserveAdbServerResetRecovery(device);
        device.sessionId = null;
        device.status = "idle";
        await this.pool.removeDevice(device.id, false, device);
        detached.push(device);
      }
      return { devices: detached, deferred: false };
    });
  }

  private async prepareAdbServerResetCohortDetachment(
    cohort: readonly PooledDevice[],
  ): Promise<void> {
    const capturedTargets = this.getAdbServerResetCohortSessionTargets(cohort);
    const capturedSessionIds = new Set(capturedTargets.map(({ sessionId }) => sessionId));
    for (const { sessionId, deviceId, session, pooledDevice } of capturedTargets) {
      const record = this.pool.startAndroidRecoveryRecord(
        sessionId,
        { deviceId, avdName: pooledDevice.avdName },
        ["quarantine", "loss"],
        true,
      );
      pooledDevice.adbServerResetSession = session;
      pooledDevice.adbServerResetRecoveryGeneration = record.generation;
    }
    try {
      for (const device of cohort) {
        if (capturedTargets.some(({ sessionId }) => sessionId === device.sessionId)) {
          device.adbServerResetIncidentId = await this.pool.recordEmulatorLossIncident(
            device.id,
            "adb-server-reset",
            undefined,
            "absent",
          );
        }
      }
      const sessionTargets = this.getAdbServerResetCohortSessionTargets(cohort).filter(
        ({ sessionId }) => capturedSessionIds.has(sessionId),
      );
      const activeSessionIds = new Set(sessionTargets.map(({ sessionId }) => sessionId));
      for (const { sessionId } of capturedTargets) {
        if (!activeSessionIds.has(sessionId)) {
          this.pool.getRecoveryCoordinator().finalizeRecoveryRecord(sessionId);
        }
      }
      for (const { sessionId, deviceId, incidentId } of sessionTargets) {
        this.pool.startAndroidRecoveryRecord(sessionId, { deviceId, incidentId }, [
          "quarantine",
          "loss",
        ]);
      }
      await this.settleAbandonedAdbResetIncidents(cohort, sessionTargets);
      // Issue both scopes before awaiting drains; idle serials also carry sessionless work.
      // Reset recovery retains its existing semantics: cancel every affected execution.
      await Promise.all([
        ...cohort.map((device) =>
          this.pool.cancelDeviceExecutions(
            device.id,
            deviceLossCancellationReason(device.id, device.adbServerResetIncidentId),
          ),
        ),
        ...sessionTargets.map(({ sessionId, deviceId, incidentId }) =>
          this.pool.cancelDeviceSessionExecutions(
            sessionId,
            deviceLossCancellationReason(deviceId, incidentId),
          ),
        ),
      ]);
      await this.stopTrackedIdleAdbResetCohortProcesses(cohort);
    } catch (error) {
      await this.settleFailedAdbResetCohortPreparation(cohort, capturedTargets);
      throw error;
    }
  }

  private async settleFailedAdbResetCohortPreparation(
    cohort: readonly PooledDevice[],
    capturedTargets: readonly { sessionId: string; deviceId: string }[],
  ): Promise<void> {
    const activeSessionIds = new Set<string>();
    for (const { sessionId, deviceId } of capturedTargets) {
      const session = this.pool.getSessionManager().getSession(sessionId);
      if (session?.assignedDevice === deviceId && session.platform === "android") {
        activeSessionIds.add(sessionId);
      } else {
        this.pool.getRecoveryCoordinator().finalizeRecoveryRecord(sessionId);
      }
    }
    for (const device of cohort) {
      if (device.adbServerResetIncidentId) {
        await this.pool.completeEmulatorLossRecovery(
          device.adbServerResetIncidentId,
          device.sessionId && activeSessionIds.has(device.sessionId)
            ? "exhausted"
            : "not-attempted",
        );
        this.pool.settleEmulatorLossIncident(device.adbServerResetIncidentId);
      }
    }
  }

  private async settleAbandonedAdbResetIncidents(
    cohort: readonly PooledDevice[],
    sessionTargets: readonly { incidentId?: string }[],
  ): Promise<void> {
    const activeIncidentIds = new Set(
      sessionTargets.flatMap(({ incidentId }) => (incidentId ? [incidentId] : [])),
    );
    for (const device of cohort) {
      const incidentId = device.adbServerResetIncidentId;
      if (incidentId && !activeIncidentIds.has(incidentId)) {
        await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
        delete device.adbServerResetIncidentId;
      }
    }
  }

  private getAdbServerResetCohortSessionTargets(cohort: readonly PooledDevice[]): Array<{
    sessionId: string;
    deviceId: string;
    session: Session;
    pooledDevice: PooledDevice;
    incidentId?: string;
  }> {
    const sessionTargets = new Map<
      string,
      { deviceId: string; session: Session; pooledDevice: PooledDevice; incidentId?: string }
    >();
    for (const device of cohort) {
      if (
        this.pool.getDevices().get(device.id) !== device ||
        !this.pool.isAndroidEmulatorActiveRelaunchEligible(device) ||
        !device.sessionId
      ) {
        continue;
      }
      const session = this.pool.getSessionManager().getSession(device.sessionId);
      if (session?.assignedDevice === device.id && session.platform === "android") {
        sessionTargets.set(device.sessionId, {
          deviceId: device.id,
          session,
          pooledDevice: device,
          ...(device.adbServerResetIncidentId
            ? { incidentId: device.adbServerResetIncidentId }
            : {}),
        });
      }
    }
    return Array.from(sessionTargets, ([sessionId, target]) => ({ sessionId, ...target }));
  }

  private async stopTrackedIdleAdbResetCohortProcesses(
    cohort: readonly PooledDevice[],
  ): Promise<void> {
    // Stop every fallible idle process before reserving or detaching any cohort
    // member. A failed stop then leaves all session routes and reservations intact.
    for (const device of cohort) {
      if (
        this.pool.getDevices().get(device.id) !== device ||
        !this.pool.isAndroidEmulatorActiveRelaunchEligible(device) ||
        device.sessionId !== null ||
        !this.pool.getStartedDeviceProcesses().has(device.id)
      ) {
        continue;
      }
      await this.pool.stopTrackedEmulatorProcess(device.id);
    }
  }

  /**
   * Wait for a cohort-level reservation created before ADB-reset recovery
   * starts. Named startup uses this so it cannot race a later cohort member.
   */
  async waitForAdbServerResetRecovery(avdName: string, signal?: AbortSignal): Promise<void> {
    const reservation = this.pool.getAdbServerResetRecoveryReservations().get(avdName);
    if (!reservation) {
      return;
    }
    await this.waitForAdbServerResetReservations([reservation], signal);
  }

  /** Snapshot the Android runtimes whose preserved sessions still own startup recovery. */
  getRecoveringAndroidTargets(): { names: Set<string>; serials: Set<string> } {
    return {
      names: new Set([
        ...this.pool.getRecoveringAndroidImages().keys(),
        ...this.pool.getAdbServerResetRecoveryReservations().keys(),
      ]),
      serials: new Set([
        ...Array.from(this.pool.getRecoveringAndroidImages().values())
          .map((image) => image.deviceId)
          .filter((deviceId): deviceId is string => Boolean(deviceId)),
        ...Array.from(this.pool.getAdbServerResetRecoveryReservations().values())
          .map((reservation) => reservation.deviceId)
          .filter(Boolean),
        ...Array.from(this.pool.getRecoveringSessionLosses().values())
          .map((recovery) => recovery.deviceId)
          .filter(Boolean),
        ...Array.from(this.pool.getRecoveringAndroidDeviceIds()).filter(Boolean),
      ]),
    };
  }

  /**
   * Atomically wait for matching reset recovery and reserve the requested AVD
   * against a concurrent reset-cohort detachment. The returned release must
   * remain held until startup has bound or abandoned the device.
   */
  async reserveAndroidStartupLease(
    name: string | undefined,
    exactName: boolean,
    signal?: AbortSignal,
    ownsOfflineRecovery = false,
  ): Promise<() => Promise<void>> {
    const owner = Symbol("android-startup-lease");
    const request: AndroidStartupLeaseRequest = { name, exactName, ownsOfflineRecovery };
    for (;;) {
      let matchingReservations: AdbServerResetRecoveryReservation[] = [];
      let matchingRecoveryAvdNames: string[] = [];
      await this.pool.getAssignmentMutex().runExclusive(() => {
        ({ matchingReservations, matchingRecoveryAvdNames } =
          this.getAndroidStartupRecoveryMatches(request));
        if (matchingReservations.length === 0 && matchingRecoveryAvdNames.length === 0) {
          this.pool.getAndroidStartupLeases().set(owner, request);
        }
      });
      this.pool.getAfterAndroidStartupRecoverySnapshot()?.();
      if (matchingReservations.length === 0 && matchingRecoveryAvdNames.length === 0) {
        break;
      }
      if (matchingReservations.length > 0) {
        await this.waitForAdbServerResetReservations(matchingReservations, signal);
      } else {
        this.throwIfRecoveryReservationUnconfirmed(matchingRecoveryAvdNames);
        await this.pool
          .getRecoveryCoordinator()
          .waitForRecoveringAndroidImages(matchingRecoveryAvdNames, signal);
      }
    }

    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await this.pool.getAssignmentMutex().runExclusive(() => {
        this.pool.getAndroidStartupLeases().delete(owner);
      });
    };
  }

  /**
   * A sessionless recovery that could not confirm the old emulator stopped keeps
   * its reservation until a later fresh observation decides it. Waiting out the
   * boot budget cannot change that, so fail at once and name the reservation.
   */
  private throwIfRecoveryReservationUnconfirmed(avdNames: readonly string[]): void {
    const avdName = this.pool
      .getRecoveryCoordinator()
      .findUnconfirmedRecoveringAndroidImage(avdNames);
    if (avdName !== undefined) {
      throw new ActionableError(
        `Android AVD '${avdName}' is reserved by an interrupted emulator recovery whose shutdown could not be confirmed. ` +
          "The reservation lifts after the next successful device refresh shows whether the emulator is still running; retry then.",
      );
    }
  }

  /**
   * Legacy startDevice accepts a partial name, unlike getAndroid's exact AVD
   * name. Do not let that compatibility path select a reserved reset member.
   */
  async waitForAdbServerResetRecoveryMatchingName(
    name: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const normalizedName = name?.toLowerCase();
    const reservations = Array.from(
      this.pool.getAdbServerResetRecoveryReservations().values(),
    ).filter(
      (reservation) =>
        normalizedName === undefined ||
        reservation.image.name.toLowerCase().includes(normalizedName),
    );
    await this.waitForAdbServerResetReservations(reservations, signal);
  }

  async releaseAdbServerResetCohortReservations(cohort: readonly PooledDevice[]): Promise<void> {
    await this.pool.getAssignmentMutex().runExclusive(() => {
      for (const device of cohort) {
        if (device.adbServerResetSessionId) {
          const sessionId = device.adbServerResetSessionId;
          const record = this.pool.getRecoveringSessionLosses().get(sessionId);
          if (!record || record.generation !== device.adbServerResetRecoveryGeneration) {
            // A later recovery reused this session or AVD. Its reservations are
            // not owned by this delayed cohort sweep.
            continue;
          }
          if (!this.canReleaseAdbServerResetSessionFence(device, sessionId)) {
            // An unsettled owner must retain both its session fence and the
            // AVD reservation, including after the cohort caller's finally.
            continue;
          }
          this.pool.getRecoveryCoordinator().finalizeRecoveryRecord(sessionId, record);
          continue;
        }
        if (!device.avdName) {
          continue;
        }
        const reservation = this.pool.getAdbServerResetRecoveryReservations().get(device.avdName);
        if (!reservation) {
          continue;
        }
        this.pool.getAdbServerResetRecoveryReservations().delete(device.avdName);
        reservation.resolve();
      }
    });
  }

  private canReleaseAdbServerResetSessionFence(device: PooledDevice, sessionId: string): boolean {
    if (this.pool.getFailedTerminalRecoveryReleases().has(sessionId)) {
      return false;
    }
    const capturedSession = device.adbServerResetSession;
    if (!capturedSession || !this.pool.getSessionManager().isCurrentSession(capturedSession)) {
      return true;
    }
    const assignedDeviceId = capturedSession.assignedDevice;
    const restoredDevice = assignedDeviceId
      ? this.pool.getDevices().get(assignedDeviceId)
      : undefined;
    return (
      restoredDevice?.sessionId === sessionId &&
      restoredDevice.status === "busy" &&
      restoredDevice.platform === "android" &&
      restoredDevice.avdName === device.avdName
    );
  }

  private reserveAdbServerResetRecovery(device: PooledDevice): void {
    if (!device.avdName || !device.androidImage) {
      return;
    }
    const sessionId = device.adbServerResetSessionId;
    const record = sessionId ? this.pool.getRecoveringSessionLosses().get(sessionId) : undefined;
    const existing = this.pool.getAdbServerResetRecoveryReservations().get(device.avdName);
    if (existing) {
      if (record && existing.recoveryGeneration !== record.generation) {
        record.reservations.add("reset-cohort");
        existing.sessionId = record.sessionId;
        existing.recoveryGeneration = record.generation;
        existing.deviceId = device.id;
      }
      return;
    }
    let resolve!: () => void;
    const settled = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    if (record) {
      record.reservations.add("reset-cohort");
    }
    this.pool.getAdbServerResetRecoveryReservations().set(device.avdName, {
      image: {
        ...device.androidImage,
        name: device.avdName,
        platform: "android",
        isRunning: false,
        source: "local",
      },
      deviceId: device.id,
      cancelled: false,
      settled,
      resolve,
      ...(record ? { sessionId: record.sessionId, recoveryGeneration: record.generation } : {}),
    });
  }

  isLeasedForAndroidStartup(avdName: string): boolean {
    return Array.from(this.pool.getAndroidStartupLeases().values()).some((request) =>
      this.androidStartupRequestMatchesAvd(request, avdName),
    );
  }

  /**
   * Whether the given serial's AVD has a startup lease that owns fresh-offline
   * recovery. Warm startup leases still serialize ADB-reset recovery, but do
   * not suppress the disconnect monitor's global reconnect. Returns `false`
   * for an untracked serial or one with no recorded `avdName`.
   */
  isDeviceLeasedForAndroidStartup(deviceId: string): boolean {
    const device = this.pool.getDevice(deviceId);
    return (
      Boolean(device?.avdName) &&
      Array.from(this.pool.getAndroidStartupLeases().values()).some(
        (request) =>
          request.ownsOfflineRecovery &&
          this.androidStartupRequestMatchesAvd(request, device!.avdName!),
      )
    );
  }

  private getAndroidStartupRecoveryMatches(request: AndroidStartupLeaseRequest): {
    matchingReservations: AdbServerResetRecoveryReservation[];
    matchingRecoveryAvdNames: string[];
  } {
    if (!request.name) {
      return { matchingReservations: [], matchingRecoveryAvdNames: [] };
    }
    return {
      matchingReservations: Array.from(this.pool.getAdbServerResetRecoveryReservations().entries())
        .filter(([avdName]) => this.androidStartupRequestMatchesAvd(request, avdName))
        .map(([, reservation]) => reservation),
      matchingRecoveryAvdNames: Array.from(this.pool.getRecoveringAndroidImages().keys()).filter(
        (avdName) => this.androidStartupRequestMatchesAvd(request, avdName),
      ),
    };
  }

  private androidStartupRequestMatchesAvd(
    request: AndroidStartupLeaseRequest,
    avdName: string,
  ): boolean {
    if (!request.name) {
      return true;
    }
    const normalizedName = request.name.toLowerCase();
    const normalizedAvdName = avdName.toLowerCase();
    return request.exactName
      ? normalizedAvdName === normalizedName
      : normalizedAvdName.includes(normalizedName);
  }

  private async waitForAdbServerResetReservations(
    reservations: readonly AdbServerResetRecoveryReservation[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.pool.getRecoveryCoordinator().waitForRecoverySettlements(
      reservations.map((reservation) => reservation.settled),
      signal,
    );
  }

  clearAdbResetRecoveryReservation(record: AndroidRecoveryRecord): void {
    if (!record.reservations.has("reset-cohort") || !record.avdName) {
      return;
    }
    const reservation = this.pool.getAdbServerResetRecoveryReservations().get(record.avdName);
    if (
      reservation?.sessionId !== record.sessionId ||
      reservation.recoveryGeneration !== record.generation
    ) {
      return;
    }
    this.pool.getAdbServerResetRecoveryReservations().delete(record.avdName);
    reservation.resolve();
  }

  consumeAdbServerResetRecoveryCancellation(device: PooledDevice): boolean {
    if (!device.avdName) {
      return false;
    }
    const reservation = this.pool.getAdbServerResetRecoveryReservations().get(device.avdName);
    if (!reservation || reservation.deviceId !== device.id || !reservation.cancelled) {
      return false;
    }
    reservation.cancelled = false;
    return true;
  }
}
