import { ActionableError, type BootedDevice, type Platform } from "../models";
import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { AutolockClient, DeviceAutolockManager } from "./deviceAutolockManager";
import type {
  DeviceReadinessReservation,
  PooledDevice,
  RestartStopTargetIdentity,
  ShutdownIdentityReservation,
} from "./devicePool";
import type { DeviceRecoveryCoordinator } from "./deviceRecoveryCoordinator";
import type { DeviceRuntimeIdentity } from "./deviceRuntimeIdentity";
import type { DeviceShutdownReservations } from "./deviceShutdownReservations";
import {
  deviceAlreadyAssignedToAnotherSessionError,
  deviceAssignedToOtherSessionError,
  DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS,
  isSameHolderSession,
} from "./inputDeviceOwnership";
import type { BindingExclusion } from "./sessionBroker/provisioning/exclusion";
import { isDeviceRestartReleaseReason } from "../db/deviceSessionRepository";
import {
  DEVICE_RESTART_RECOVERY_WINDOW_MS,
  type RehydrationDeviceReservation,
  type Session,
  type SessionManager,
  type SessionReleaseOptions,
  type SessionReleaseSnapshot,
} from "./sessionManager";

export type DeviceRehydrationReservation = RehydrationDeviceReservation["target"] & {
  daemonRehydration?: boolean;
  restartHandoff?: boolean;
  expiryTimer?: NodeJS.Timeout;
  scheduledDeadlineMs?: number;
  idleDeadlineMs?: number;
  releasePersistence?: Promise<void>;
  sessionTimeoutMs?: number;
  recoveryWindowEndMs?: number;
  ownerMcpSessionIds?: ReadonlySet<string>;
  ownerLivenessToken?: string;
};

export interface DeviceReservationsPort {
  readonly devices: Pick<ReadonlyMap<string, PooledDevice>, "get" | "has">;
  readonly rehydrationReservations: Pick<
    Map<string, DeviceRehydrationReservation>,
    "get" | "set" | "entries" | "keys" | "delete" | "size" | typeof Symbol.iterator
  >;
  readonly mcpSessionRecoveryDevices: Pick<
    Map<string, { readonly device: PooledDevice; readonly token: symbol }>,
    "has" | "get" | "set" | "delete" | typeof Symbol.iterator
  >;
  readonly pooledSessionIdentities: Pick<WeakMap<PooledDevice, Session>, "get">;
  readonly sessionManager: Pick<
    SessionManager,
    | "getSession"
    | "isLatestSessionIdentity"
    | "reserveSessionForTerminalRelease"
    | "expireRestartRecoveryReservation"
    | "sessionNow"
    | "getDeviceLabels"
  >;
  readonly shutdownReservationCoordinator: Pick<
    DeviceShutdownReservations,
    | "reserveDeviceForReadiness"
    | "isReservedForReadiness"
    | "hasReadinessNameReservation"
    | "isReservedForShutdown"
    | "isDeviceUnderShutdown"
  >;
  readonly recoveryCoordinator: Pick<DeviceRecoveryCoordinator, "isAndroidRecoveryHandoffReserved">;
  readonly autolockManager: Pick<DeviceAutolockManager, "getOwnedAutolockSession">;
  readonly runtimeIdentity: Pick<DeviceRuntimeIdentity, "hasUnresolvedEmulatorName">;
  readonly bindingExclusion: Pick<BindingExclusion, "refresh" | "holderOf"> | undefined;
  readonly timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  reserveDeviceForReadiness: DeviceReservations["reserveDeviceForReadiness"];
  assertCallerOwnsDeviceSession(
    client: AutolockClient | undefined,
    session: Session,
    device: PooledDevice,
  ): boolean;
  notifyReservationChanged(deviceId: string, platform: Platform): void;
  notifyRehydrationReservationChanged(
    target: Pick<RehydrationDeviceReservation["target"], "platform" | "stableDeviceId">,
  ): void;
  notifyDeviceStateChanged(device: Pick<PooledDevice, "id" | "platform">): void;
  getDevicesByPlatform(platform: Platform): PooledDevice[];
  getRecoveringAndroidTargets(): { names: Set<string>; serials: Set<string> };
  isReservedForShutdown(device: PooledDevice): boolean;
  isManagedSlotDevice(device: PooledDevice): boolean;
  isPooledAndroidEmulator(deviceId: string): boolean;
  stableDeviceIdFor(device: PooledDevice): string | undefined;
  restartReservationsForStop(
    deviceId: string,
    identity?: RestartStopTargetIdentity,
    ownerRequester?: { sessionUuid?: string; mcpSessionId?: string },
  ): [string, DeviceRehydrationReservation][];
  restartStopNamesForeignConnection(
    sessionId: string,
    target: { ownerMcpSessionIds?: ReadonlySet<string> },
    requester: { sessionUuid?: string; mcpSessionId?: string },
  ): boolean;
}

export class DeviceReservations {
  constructor(private readonly port: DeviceReservationsPort) {}

  private rehydrationReservationsStopped = false;

  // Permission is scoped to one admitted start's actual symbols, never every hold on R's target.
  readonly restartReadiness = new Set<{
    sessionId: string;
    deviceId: string;
    owners: Set<symbol>;
  }>();

  async reserveDeviceForReadiness(
    deviceId: string,
    expectedIdentity: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
    stableRuntimeName = expectedIdentity.name,
    verifiedAndroidAvdName?: string,
    autolockClient?: AutolockClient & { restartResumeSessionId?: string },
    enforceAndroidRecoveryExclusion = false,
  ): Promise<DeviceReadinessReservation> {
    const reservation = await this.port.shutdownReservationCoordinator.reserveDeviceForReadiness(
      deviceId,
      expectedIdentity,
      stableRuntimeName,
      verifiedAndroidAvdName,
      autolockClient,
      enforceAndroidRecoveryExclusion,
    );
    // A reservation hides an idle device from allocation, so taking and giving it back are
    // idle/assigned transitions subscribers must hear about (#11568).
    this.port.notifyReservationChanged(deviceId, expectedIdentity.platform);
    const release = async (): Promise<void> => {
      await reservation();
      this.port.notifyReservationChanged(deviceId, expectedIdentity.platform);
    };
    return Object.assign(release, { owner: reservation.owner });
  }

  /** An admitted owner may prepare R even if R's control call recovered it during boot. */
  async reserveRestartRecoveryReadiness(
    device: BootedDevice,
    stableRuntimeName: string,
    sessionId: string,
  ): Promise<DeviceReadinessReservation> {
    const permission = { sessionId, deviceId: device.deviceId, owners: new Set<symbol>() };
    this.restartReadiness.add(permission);
    try {
      const reservation = await this.port.reserveDeviceForReadiness(
        device.deviceId,
        device,
        stableRuntimeName,
        undefined,
        { restartResumeSessionId: sessionId },
        true,
      );
      permission.owners.add(reservation.owner);
      return Object.assign(
        async () => {
          try {
            await reservation();
          } finally {
            this.restartReadiness.delete(permission);
          }
        },
        { owner: reservation.owner },
      );
    } catch (error) {
      this.restartReadiness.delete(permission);
      throw error;
    }
  }

  restartReadinessOwners(device: PooledDevice, sessionId?: string): ReadonlySet<symbol> {
    const owners = new Set<symbol>();
    for (const permission of this.restartReadiness) {
      if (permission.sessionId === sessionId && permission.deviceId === device.id) {
        for (const owner of permission.owners) {
          owners.add(owner);
        }
      }
    }
    return owners;
  }

  /**
   * Whether some acquisition is preparing this device right now and has not bound it yet.
   * Synchronous (no assignment lock): a selector start reads it to prefer another match (#11651).
   */
  isReservedForReadiness(deviceId: string, exceptOwners?: ReadonlySet<symbol>): boolean {
    return this.port.shutdownReservationCoordinator.isReservedForReadiness(deviceId, exceptOwners);
  }

  hasReadinessNameReservation(
    device: PooledDevice,
    readinessReservationOwners?: ReadonlySet<symbol>,
  ): boolean {
    return this.port.shutdownReservationCoordinator.hasReadinessNameReservation(
      device,
      readinessReservationOwners,
    );
  }

  assertReadinessReservationOwner(
    device: PooledDevice,
    client: (AutolockClient & { restartResumeSessionId?: string }) | undefined,
  ): void {
    const session = device.sessionId ? this.port.sessionManager.getSession(device.sessionId) : null;
    if (!session) {
      return;
    }
    if (device.autolockSessionId) {
      this.port.autolockManager.getOwnedAutolockSession(device, client);
      return;
    }
    if (client?.restartResumeSessionId !== undefined) {
      // R may have recovered before the start restores its connection ownership, but that
      // admission never authorizes preparing another live holder after R's restart hold ends.
      if (session.sessionId !== client.restartResumeSessionId) {
        throw deviceAlreadyAssignedToAnotherSessionError(device.id);
      }
      return;
    }
    this.port.assertCallerOwnsDeviceSession(client, session, device);
  }

  assertAndroidRecoveryExclusionForReadinessReservation(
    device: PooledDevice | undefined,
    expectedIdentity: Pick<BootedDevice, "deviceId" | "name" | "platform">,
    stableRuntimeName: string,
    enforceAndroidRecoveryExclusion: boolean,
  ): void {
    if (!enforceAndroidRecoveryExclusion || expectedIdentity.platform !== "android") {
      return;
    }
    const recoveryTargets = this.port.getRecoveringAndroidTargets();
    const isRecoveringName = [device?.name, expectedIdentity.name, stableRuntimeName].some(
      (identifier) => identifier !== undefined && recoveryTargets.names.has(identifier),
    );
    const isRecoveringSerial =
      this.port.runtimeIdentity.hasUnresolvedEmulatorName(expectedIdentity) &&
      [device?.id, expectedIdentity.deviceId].some(
        (identifier) => identifier !== undefined && recoveryTargets.serials.has(identifier),
      );
    const isRecoveringCurrentPooledDevice =
      device?.id === expectedIdentity.deviceId &&
      device.name === expectedIdentity.name &&
      recoveryTargets.serials.has(device.id);
    const isRecoveringTarget =
      isRecoveringName || isRecoveringSerial || isRecoveringCurrentPooledDevice;
    if (!isRecoveringTarget) {
      return;
    }
    throw new ActionableError(
      `Android device '${expectedIdentity.name}' entered recovery while awaiting its readiness reservation; retry the request.`,
    );
  }

  reserveShutdownSessionIdentity(deviceId: string): ShutdownIdentityReservation {
    const device = this.port.devices.get(deviceId);
    if (device && this.port.shutdownReservationCoordinator.isReservedForShutdown(device)) {
      throw new ActionableError(`Device '${deviceId}' is already shutting down.`);
    }
    const candidate = device ? this.port.pooledSessionIdentities.get(device) : undefined;
    const session =
      candidate !== undefined &&
      candidate.sessionId === device?.sessionId &&
      candidate.assignedDevice === deviceId &&
      this.port.sessionManager.isLatestSessionIdentity(candidate)
        ? candidate
        : undefined;
    return {
      device,
      assignmentCount: device?.assignmentCount,
      session,
      releaseSession: session
        ? this.port.sessionManager.reserveSessionForTerminalRelease(session, deviceId)
        : undefined,
    };
  }

  reserveMcpSessionRecoveryLease(
    mcpSessionId: string | undefined,
    device: PooledDevice,
    token: symbol | undefined,
  ): void {
    if (!mcpSessionId || token === undefined) {
      return;
    }
    if (this.port.mcpSessionRecoveryDevices.has(mcpSessionId)) {
      throw new ActionableError(`MCP session '${mcpSessionId}' is already recovering a device.`);
    }
    this.port.mcpSessionRecoveryDevices.set(mcpSessionId, { device, token });
  }

  releaseMcpSessionRecoveryLease(
    mcpSessionId: string | undefined,
    token: symbol | undefined,
  ): void {
    if (
      mcpSessionId &&
      token !== undefined &&
      this.port.mcpSessionRecoveryDevices.get(mcpSessionId)?.token === token
    ) {
      this.port.mcpSessionRecoveryDevices.delete(mcpSessionId);
    }
  }

  transferMcpSessionRecoveryLeases(previous: PooledDevice, replacement: PooledDevice): void {
    for (const [mcpSessionId, lease] of this.port.mcpSessionRecoveryDevices) {
      if (lease.device === previous) {
        this.port.mcpSessionRecoveryDevices.set(mcpSessionId, { ...lease, device: replacement });
      }
    }
  }

  isReservedOutsideReadiness(device: PooledDevice, forSessionId?: string): boolean {
    return (
      this.port.recoveryCoordinator.isAndroidRecoveryHandoffReserved(device.id) ||
      this.port.isReservedForShutdown(device) ||
      this.port.shutdownReservationCoordinator.isDeviceUnderShutdown(device.id) ||
      this.isReservedForOtherRehydration(device, forSessionId)
    );
  }

  /**
   * Hold each persisted row's device for that row while daemon restart recovery works through
   * the rows (#11294), so an allocation arriving meanwhile cannot take a device a row is about
   * to recover onto. The reservation is by identity, so it also covers a device discovery has
   * not listed yet. A device a managed slot holds is not reserved: the slot wins, and the row
   * recovers or fails through the normal path. When two rows name one device the first keeps it.
   */
  async reserveDevicesForRehydration(rows: readonly RehydrationDeviceReservation[]): Promise<void> {
    await this.reserveRehydrationDevices(rows);
  }

  async reserveRehydrationDevices(
    rows: readonly RehydrationDeviceReservation[],
    stillCurrent: () => boolean = () => true,
    restartHandoff = false,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    if (this.port.bindingExclusion) {
      try {
        await this.port.bindingExclusion.refresh({ requireCurrent: true });
      } catch (error) {
        // Which devices managed slots hold is unknown, and they win: reserve nothing.
        logger.warn(
          `[DevicePool] Not reserving devices for restart recovery: ${errorMessage(error)}`,
          error,
        );
        return;
      }
    }
    if (this.rehydrationReservationsStopped || !stillCurrent()) {
      return;
    }
    for (const { sessionId, target } of rows) {
      const managed = this.port.bindingExclusion?.holderOf({
        platform: target.platform,
        stableIds: [target.stableDeviceId, target.deviceId],
      });
      const alreadyReserved = [...this.port.rehydrationReservations.entries()].some(
        ([holder, reserved]) =>
          holder !== sessionId &&
          reserved.platform === target.platform &&
          reserved.stableDeviceId === target.stableDeviceId,
      );
      if (!managed && !alreadyReserved) {
        this.replaceRehydrationReservation(sessionId, target, restartHandoff);
      }
    }
  }

  replaceRehydrationReservation(
    sessionId: string,
    target: RehydrationDeviceReservation["target"],
    restartHandoff: boolean,
  ): void {
    const previous = this.port.rehydrationReservations.get(sessionId);
    const targetChanged =
      !previous ||
      previous.platform !== target.platform ||
      previous.stableDeviceId !== target.stableDeviceId;
    // A second source shares the same entry, including the handoff timer's identity fence.
    const entry = previous && !targetChanged ? previous : { ...target };
    Object.assign(entry, target, {
      restartHandoff: restartHandoff || previous?.restartHandoff,
      daemonRehydration: !restartHandoff || previous?.daemonRehydration,
    });
    this.port.rehydrationReservations.set(sessionId, entry);
    if (previous && targetChanged) {
      this.port.notifyRehydrationReservationChanged(previous);
    }
    if (targetChanged) {
      this.port.notifyRehydrationReservationChanged(target);
    }
  }

  /** The reserved device's bucket moved, but the reservation names it by identity: tell observers of every match. */
  emitRehydrationReservationChanged(
    target: Pick<RehydrationDeviceReservation["target"], "platform" | "stableDeviceId">,
  ): void {
    for (const device of this.port.getDevicesByPlatform(target.platform)) {
      if (this.port.stableDeviceIdFor(device) === target.stableDeviceId) {
        this.port.notifyDeviceStateChanged(device);
      }
    }
  }

  armDeviceRestartReservationExpiry(sessionId: string, releasedAtMs: number): void {
    const target = this.port.rehydrationReservations.get(sessionId);
    if (!target) {
      return;
    }
    target.recoveryWindowEndMs = releasedAtMs + DEVICE_RESTART_RECOVERY_WINDOW_MS;
    const deadline = Math.min(
      target.idleDeadlineMs ?? Number.POSITIVE_INFINITY,
      releasedAtMs + DEVICE_RESTART_RECOVERY_WINDOW_MS,
    );
    this.scheduleDeviceRestartReservationExpiry(sessionId, deadline);
  }

  scheduleDeviceRestartReservationExpiry(sessionId: string, deadline: number): void {
    const target = this.port.rehydrationReservations.get(sessionId);
    if (!target?.restartHandoff || target.scheduledDeadlineMs === deadline) {
      return;
    }
    if (target.expiryTimer) {
      this.port.timer.clearTimeout(target.expiryTimer);
    }
    target.scheduledDeadlineMs = deadline;
    target.expiryTimer = this.port.timer.setTimeout(
      () => {
        if (this.port.rehydrationReservations.get(sessionId) !== target) {
          return;
        }
        target.scheduledDeadlineMs = undefined;
        if (this.port.sessionManager.sessionNow() >= target.recoveryWindowEndMs!) {
          this.releaseDeviceRestartReservation(sessionId);
        } else {
          // A stalled persistence check must not carry the hold past the cold-boot window.
          this.scheduleDeviceRestartReservationExpiry(sessionId, target.recoveryWindowEndMs!);
        }
        void this.checkDeviceRestartReservationExpiry(sessionId, target).catch((error: unknown) => {
          // Keep the hold on a failed row read/write and retry; a terminal callback still ends it.
          logger.warn(
            `[DevicePool] Failed to expire restart hold for ${sessionId}: ${errorMessage(error)}`,
          );
          if (this.port.rehydrationReservations.get(sessionId) === target) {
            this.scheduleDeviceRestartReservationExpiry(
              sessionId,
              Math.min(this.port.sessionManager.sessionNow() + 1_000, target.recoveryWindowEndMs!),
            );
          }
        });
      },
      Math.max(0, deadline - this.port.sessionManager.sessionNow()),
    );
  }

  async checkDeviceRestartReservationExpiry(
    sessionId: string,
    target: RehydrationDeviceReservation["target"],
  ): Promise<void> {
    const deadline = await this.port.sessionManager.expireRestartRecoveryReservation(sessionId);
    const current = this.port.rehydrationReservations.get(sessionId);
    if (!current || current !== target) {
      return;
    }
    if (deadline === undefined) {
      this.releaseDeviceRestartReservation(sessionId);
    } else {
      this.scheduleDeviceRestartReservationExpiry(
        sessionId,
        current.recoveryWindowEndMs === undefined
          ? deadline
          : Math.min(deadline, current.recoveryWindowEndMs),
      );
    }
  }

  releaseDeviceRestartReservation(sessionId: string): void {
    const target = this.port.rehydrationReservations.get(sessionId);
    if (!target?.restartHandoff) {
      return;
    }
    target.restartHandoff = false;
    target.ownerMcpSessionIds = undefined;
    target.ownerLivenessToken = undefined;
    target.scheduledDeadlineMs = undefined;
    if (target.expiryTimer) {
      this.port.timer.clearTimeout(target.expiryTimer);
      target.expiryTimer = undefined;
    }
    if (!target.daemonRehydration) {
      this.releaseRehydrationReservation(sessionId);
    }
  }

  /** End the daemon batch's hold; terminal releases and daemon/pool shutdown end both sources (#11294). */
  releaseRehydrationReservation(sessionId: string, terminal = false): void {
    const target = this.port.rehydrationReservations.get(sessionId);
    if (!target) {
      return;
    }
    target.daemonRehydration = false;
    if (target.restartHandoff && !terminal) {
      return;
    }
    this.port.rehydrationReservations.delete(sessionId);
    if (target.expiryTimer) {
      this.port.timer.clearTimeout(target.expiryTimer);
    }
    logger.info(`[DevicePool] Released the restart-recovery reservation for ${sessionId}`);
    this.port.notifyRehydrationReservationChanged(target);
  }

  /**
   * The session whose restart recovery `device` is reserved for, if any (#11294). A device a
   * managed slot holds is never reserved, whenever the slot took it: the slot wins, and the row
   * recovers or fails (target-busy once the slot's execution is bound) through the normal path.
   */
  rehydrationReservationHolder(device: PooledDevice): string | undefined {
    if (this.port.rehydrationReservations.size === 0 || this.port.isManagedSlotDevice(device)) {
      return undefined;
    }
    const stableId = this.port.stableDeviceIdFor(device);
    for (const [sessionId, target] of this.port.rehydrationReservations) {
      if (
        target.platform === device.platform &&
        target.stableDeviceId === stableId &&
        (target.androidEmulator === undefined ||
          this.port.isPooledAndroidEmulator(device.id) === target.androidEmulator)
      ) {
        return sessionId;
      }
    }
    return undefined;
  }

  isReservedForOtherRehydration(device: PooledDevice, forSessionId?: string): boolean {
    const holder = this.rehydrationReservationHolder(device);
    return holder !== undefined && holder !== forSessionId;
  }

  /** Read-only pre-boot admission, including stopped images; managed slots retain priority. */
  restartReservationForStart(
    platform: Platform,
    identities: readonly string[],
    requester: { sessionUuid?: string; mcpSessionId?: string; oneShotCli?: boolean },
  ):
    | {
        sessionUuid: string;
        owned: boolean;
        restartHandoff: boolean;
        target: RehydrationDeviceReservation["target"];
        deviceId: string;
        retryAfterMs: number;
      }
    | undefined {
    for (const [sessionUuid, target] of this.port.rehydrationReservations) {
      if (
        target.platform !== platform ||
        !this.startMatchesRestartReservation(platform, identities, sessionUuid, target) ||
        this.port.bindingExclusion?.holderOf({
          platform,
          stableIds: [target.stableDeviceId, target.deviceId],
        })
      ) {
        continue;
      }
      return {
        sessionUuid,
        owned: this.ownsRestartReservation(sessionUuid, requester),
        restartHandoff: target.restartHandoff === true,
        target,
        deviceId: target.deviceId,
        retryAfterMs:
          target.scheduledDeadlineMs === undefined
            ? DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS
            : Math.max(1, target.scheduledDeadlineMs - this.port.sessionManager.sessionNow()),
      };
    }
    return undefined;
  }

  startMatchesRestartReservation(
    platform: Platform,
    identities: readonly string[],
    sessionUuid: string,
    target: RehydrationDeviceReservation["target"],
  ): boolean {
    return identities.some((id) => {
      const pooled = this.port.devices.get(id);
      // A recycled runtime serial is the current occupant, not the old reserved image.
      if (pooled) {
        return (
          pooled.platform === platform && this.rehydrationReservationHolder(pooled) === sessionUuid
        );
      }
      return id === target.stableDeviceId || id === target.deviceId;
    });
  }

  /** Stable and runtime identities a selector must skip before any discovery can boot them. */
  restartReservationExclusions(
    platform: Platform,
    requester: { sessionUuid?: string; mcpSessionId?: string; oneShotCli?: boolean },
  ): {
    names: ReadonlySet<string>;
    ids: ReadonlySet<string>;
    resumeTargets: readonly RehydrationDeviceReservation[];
  } {
    const names = new Set<string>();
    const ids = new Set<string>();
    const resumeTargets: RehydrationDeviceReservation[] = [];
    for (const [sessionUuid, target] of this.port.rehydrationReservations) {
      if (target.platform !== platform) {
        continue;
      }
      if (this.ownsRestartReservation(sessionUuid, requester)) {
        if (target.restartHandoff) {
          resumeTargets.push({
            sessionId: sessionUuid,
            target: {
              platform: target.platform,
              stableDeviceId: target.stableDeviceId,
              deviceId: target.deviceId,
              androidEmulator: target.androidEmulator,
            },
          });
        }
        continue;
      }
      names.add(target.stableDeviceId);
      ids.add(target.stableDeviceId);
      if (
        !this.port.devices.has(target.deviceId) ||
        this.rehydrationReservationHolder(this.port.devices.get(target.deviceId)!) === sessionUuid
      ) {
        ids.add(target.deviceId);
      }
      for (const device of this.port.getDevicesByPlatform(platform)) {
        if (this.rehydrationReservationHolder(device) === sessionUuid) {
          ids.add(device.id);
        }
      }
    }
    return { names, ids, resumeTargets };
  }

  /** A stop naming a restart holder cannot impersonate its handoff connection, even with force. */
  isRestartReservationOwnedByOtherConnection(
    deviceId: string,
    requester: { sessionUuid?: string; mcpSessionId?: string },
    identity?: RestartStopTargetIdentity,
  ): boolean {
    return this.port
      .restartReservationsForStop(deviceId, identity, requester)
      .some(([sessionId, target]) =>
        this.port.restartStopNamesForeignConnection(sessionId, target, requester),
      );
  }

  restartReservationHasConnectionOwner(
    target: { ownerMcpSessionIds?: ReadonlySet<string> } | undefined,
    mcpSessionId: string | undefined,
  ): boolean {
    return mcpSessionId !== undefined && target?.ownerMcpSessionIds?.has(mcpSessionId) === true;
  }

  ownsRestartReservation(
    sessionUuid: string,
    requester: { sessionUuid?: string; mcpSessionId?: string; oneShotCli?: boolean },
  ): boolean {
    return (
      isSameHolderSession(sessionUuid, requester.sessionUuid, this.port.sessionManager) ||
      (requester.oneShotCli !== true &&
        this.restartReservationHasConnectionOwner(
          this.port.rehydrationReservations.get(sessionUuid),
          requester.mcpSessionId,
        ))
    );
  }

  /** Restart recovery is about to put another session back on `device` (#11294). */
  assertNotReservedForOtherRehydration(device: PooledDevice, sessionId: string | undefined): void {
    const holder = this.rehydrationReservationHolder(device);
    if (holder !== undefined && holder !== sessionId) {
      throw deviceAssignedToOtherSessionError(device.id, holder, sessionId);
    }
  }
  releaseForShutdown(): void {
    this.rehydrationReservationsStopped = true;
    this.restartReadiness.clear();
    for (const sessionId of [...this.port.rehydrationReservations.keys()]) {
      this.releaseRehydrationReservation(sessionId, true);
    }
  }

  handleRestartRecoveryActivity(sessionId: string, atMs: number): void {
    const target = this.port.rehydrationReservations.get(sessionId);
    if (target?.restartHandoff && target.sessionTimeoutMs !== undefined) {
      target.idleDeadlineMs = Math.max(target.idleDeadlineMs ?? 0, atMs + target.sessionTimeoutMs);
      if (!target.releasePersistence) {
        this.scheduleDeviceRestartReservationExpiry(
          sessionId,
          Math.min(target.idleDeadlineMs, target.recoveryWindowEndMs!),
        );
      }
    }
  }

  handleSessionCreated(session: Pick<Session, "sessionId">): void {
    if (this.port.rehydrationReservations.get(session.sessionId)?.restartHandoff) {
      this.releaseDeviceRestartReservation(session.sessionId);
    }
  }

  handleSessionRelease(
    sessionId: string,
    reason: string,
    snapshot: Pick<SessionReleaseSnapshot, "terminal" | "releasedAtMs">,
    options: Pick<SessionReleaseOptions, "releasePersisted">,
  ): void {
    if (snapshot.terminal) {
      // Includes terminal upgrades of an already completed restart handoff.
      this.releaseRehydrationReservation(sessionId, true);
    } else if (isDeviceRestartReleaseReason(reason)) {
      const target = this.port.rehydrationReservations.get(sessionId);
      if (target?.restartHandoff && options.releasePersisted) {
        const persistence = options.releasePersisted;
        target.releasePersistence = persistence;
        void persistence.then(() => {
          if (
            this.port.rehydrationReservations.get(sessionId) === target &&
            target.restartHandoff &&
            target.releasePersistence === persistence
          ) {
            target.releasePersistence = undefined;
            this.armDeviceRestartReservationExpiry(sessionId, snapshot.releasedAtMs);
          }
        });
      }
    }
  }
}
