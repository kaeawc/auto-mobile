import { holderOf } from "../deviceBinding";
import { DeviceOwnedByOtherDaemonError } from "../../models/deviceAcquisitionRefusals";
import { logger } from "../../utils/logger";
import { BootedDevice, Platform } from "../../models";
import { devicePreparedForOtherRequestError } from "../inputDeviceOwnership";
import { type AutolockClient } from "../deviceAutolockManager";
import { type ShutdownDeviceReservation } from "../deviceShutdownReservations";
import type { PooledDevice } from "../devicePoolTypes";
import {
  ShutdownForeignClaim,
  ShutdownIdentityReservation,
  DeviceReadinessReservation,
  type ReadinessReservationOptions,
  type ShutdownReservationOptions,
} from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface ReservationsOperations {
  clearUnpooledShutdown(deviceId: string): void;
  fenceUnpooledShutdown(deviceId: string): () => void;
  settleUnpooledShutdown(deviceId: string): void;
  reserveDeviceForReadiness(
    deviceId: string,
    expectedIdentity: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
    stableRuntimeName?: string,
    verifiedAndroidAvdName?: string,
    options?: ReadinessReservationOptions,
  ): Promise<DeviceReadinessReservation>;
  /** An admitted owner may prepare R even if R's control call recovered it during boot. */
  reserveRestartRecoveryReadiness(
    device: BootedDevice,
    stableRuntimeName: string,
    sessionId: string,
  ): Promise<DeviceReadinessReservation>;
  restartReadinessOwners(device: PooledDevice, sessionId?: string): ReadonlySet<symbol>;
  notifyReservationChanged(deviceId: string, platform: Platform): void;
  notifyingShutdownReservation(reservation: ShutdownDeviceReservation): ShutdownDeviceReservation;
  reserveDeviceForShutdown(
    deviceId: string,
    abortSignal?: AbortSignal,
    autolockClient?: AutolockClient,
    assertHolder?: () => void,
    options?: ShutdownReservationOptions,
  ): Promise<ShutdownDeviceReservation | undefined>;
  claimShutdownAgainstOtherDaemons(
    reservation: ShutdownDeviceReservation,
    foreignClaim: ShutdownForeignClaim,
  ): Promise<ShutdownDeviceReservation>;
  /**
   * Whether a shutdown reservation holds the device's current incarnation right now. Synchronous
   * (no assignment lock), for a lease-status answer to another daemon (#11200).
   */
  isUnderShutdownReservation(deviceId: string): boolean;
  /**
   * Whether some acquisition is preparing this device right now and has not bound it yet.
   * Synchronous (no assignment lock): a selector start reads it to prefer another match (#11651).
   */
  isReservedForReadiness(deviceId: string, exceptOwners?: ReadonlySet<symbol>): boolean;
  /**
   * Refuse to select a device another request is still preparing: it holds a live readiness
   * reservation and no session has been bound yet (#11651, owner decision 2026-10-11). Typed
   * `device_owned_by_other_session`, retryable: it ends when that request binds (a held device,
   * with the usual rules) or releases its reservation on failure or cancellation. A device a live
   * session already holds is left to those rules, so its holder re-selecting it while its own
   * start refreshes readiness is not refused. Synchronous, so a caller can also ask before its
   * first side effect; the bind asks again under the assignment mutex. Virtual-device starts
   * are serialised by the lifecycle lease. Physical Android devices have no lease identity,
   * so their starts still race at the bind as before. Internal acquisitions keep the permissive
   * bind default; an opt-in caller may exclude its own reservation owners.
   */
  assertNotPreparedForOtherRequest(deviceId: string, ownReservations?: ReadonlySet<symbol>): void;
  hasReadinessNameReservation(
    device: PooledDevice,
    readinessReservationOwners?: ReadonlySet<symbol>,
  ): boolean;
  isReservedForShutdown(device: PooledDevice): boolean;
  assertReadinessReservationOwner(
    device: PooledDevice,
    client:
      | (AutolockClient & {
          restartResumeSessionId?: string;
        })
      | undefined,
  ): void;
  assertAndroidRecoveryExclusionForReadinessReservation(
    device: PooledDevice | undefined,
    expectedIdentity: Pick<BootedDevice, "deviceId" | "name" | "platform">,
    stableRuntimeName: string,
    enforceAndroidRecoveryExclusion: boolean,
  ): void;
  reserveShutdownSessionIdentity(deviceId: string): ShutdownIdentityReservation;
  reserveMcpSessionRecoveryLease(
    mcpSessionId: string | undefined,
    device: PooledDevice,
    token: symbol | undefined,
  ): void;
  releaseMcpSessionRecoveryLease(mcpSessionId: string | undefined, token: symbol | undefined): void;
  transferMcpSessionRecoveryLeases(previous: PooledDevice, replacement: PooledDevice): void;
  completeShutdownSessionIdentity(
    deviceId: string,
    device: PooledDevice,
    identity: ShutdownIdentityReservation,
  ): void;
}
type ReservationsState = Pick<
  DevicePoolState,
  | "deviceReservations"
  | "shutdownReservationCoordinator"
  | "connectionOwnership"
  | "devices"
  | "sessionManager"
  | "pooledSessionIdentities"
>;
export type ReservationsCallbacks = Pick<
  DevicePoolOperations,
  "notifyDeviceStateChanged" | "foreignOwnershipFor" | "isReservedForReadiness"
>;

/** Reservations responsibilities of DevicePool. */
export class DevicePoolReservations {
  constructor(
    private readonly state: ReservationsState,
    private readonly callbacks: ReservationsCallbacks,
  ) {}
  reserveDeviceForReadiness(
    deviceId: string,
    expectedIdentity: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
    stableRuntimeName?: string,
    verifiedAndroidAvdName?: string,
    options?: ReadinessReservationOptions,
  ): Promise<DeviceReadinessReservation> {
    return this.state.deviceReservations.reserveDeviceForReadiness(
      deviceId,
      expectedIdentity,
      stableRuntimeName,
      verifiedAndroidAvdName,
      options,
    );
  }

  /** An admitted owner may prepare R even if R's control call recovered it during boot. */
  reserveRestartRecoveryReadiness(
    device: BootedDevice,
    stableRuntimeName: string,
    sessionId: string,
  ): Promise<DeviceReadinessReservation> {
    return this.state.deviceReservations.reserveRestartRecoveryReadiness(
      device,
      stableRuntimeName,
      sessionId,
    );
  }

  restartReadinessOwners(device: PooledDevice, sessionId?: string): ReadonlySet<symbol> {
    return this.state.deviceReservations.restartReadinessOwners(device, sessionId);
  }

  notifyReservationChanged(deviceId: string, platform: Platform): void {
    this.callbacks.notifyDeviceStateChanged({ id: deviceId, platform });
  }

  /** Report the shutdown reservation being taken now and being given back later (#11568). */
  notifyingShutdownReservation(reservation: ShutdownDeviceReservation): ShutdownDeviceReservation {
    const { device } = reservation;
    this.notifyReservationChanged(device.id, device.platform);
    return {
      ...reservation,
      release: async () => {
        await reservation.release();
        this.notifyReservationChanged(device.id, device.platform);
      },
    };
  }

  clearUnpooledShutdown(deviceId: string): void {
    this.state.shutdownReservationCoordinator.clearUnpooledShutdown(deviceId);
  }

  fenceUnpooledShutdown(deviceId: string): () => void {
    return this.state.shutdownReservationCoordinator.fenceUnpooledShutdown(deviceId);
  }

  settleUnpooledShutdown(deviceId: string): void {
    this.state.shutdownReservationCoordinator.settleUnpooledShutdown(deviceId);
  }

  /**
   * @param options.foreignClaim set by lifecycle tools that stop a device another daemon could be
   *   driving (killDevice, deleteDevice, #11200): see {@link claimShutdownAgainstOtherDaemons}.
   */
  async reserveDeviceForShutdown(
    deviceId: string,
    abortSignal?: AbortSignal,
    autolockClient?: AutolockClient,
    assertHolder?: () => void,
    { foreignClaim, ...coordinatorOptions }: ShutdownReservationOptions = {},
  ): Promise<ShutdownDeviceReservation | undefined> {
    const reserved = await this.state.shutdownReservationCoordinator.reserveDeviceForShutdown(
      deviceId,
      abortSignal,
      autolockClient,
      assertHolder,
      coordinatorOptions,
    );
    const reservation = reserved && this.notifyingShutdownReservation(reserved);
    if (!reservation || !foreignClaim) {
      return reservation;
    }
    return await this.claimShutdownAgainstOtherDaemons(reservation, foreignClaim);
  }

  /**
   * Publish this daemon's allocation claim on a device it reserved for shutdown, so another live
   * daemon can neither be holding it nor bind it while it is stopped (#11200). The reservation
   * already keeps this daemon's own allocation off the device; the claim does the same for other
   * daemons, whose claim check sees the device in use here (`deviceLeaseStatus` counts the
   * reservation as an active execution). When another live daemon's claim wins, the reservation
   * is given back and the stop refused, unless the user forced it (logged). The claim is withdrawn
   * with the reservation.
   */
  async claimShutdownAgainstOtherDaemons(
    reservation: ShutdownDeviceReservation,
    foreignClaim: ShutdownForeignClaim,
  ): Promise<ShutdownDeviceReservation> {
    const { device } = reservation;
    const ownership = this.callbacks.foreignOwnershipFor(device.platform);
    if (!ownership || this.state.connectionOwnership.hasClaim(device.id)) {
      // No claims tracked for this platform, or a session of this daemon already claims it.
      return reservation;
    }
    if (await ownership.claim(device.id)) {
      let withdrawn = false;
      return {
        ...reservation,
        release: async () => {
          try {
            await reservation.release();
          } finally {
            // Release may be called more than once; withdraw once, and never a claim a session
            // of this daemon published since.
            if (!withdrawn && !this.state.connectionOwnership.hasClaim(device.id)) {
              ownership.release(device.id);
            }
            withdrawn = true;
          }
        },
      };
    }
    await ownership.refresh([device.id]);
    const ownerPid = ownership.foreignOwnerPid(device.id);
    if (foreignClaim.force) {
      logger.warn(
        `[DevicePool] ${foreignClaim.toolName} force-stopping device '${device.id}' claimed by ` +
          `another AutoMobile daemon${ownerPid === undefined ? "" : ` (PID ${ownerPid})`}.`,
      );
      return reservation;
    }
    await reservation.release();
    throw new DeviceOwnedByOtherDaemonError(device.id, ownerPid, foreignClaim.remedy);
  }

  /**
   * Whether a shutdown reservation holds the device's current incarnation right now. Synchronous
   * (no assignment lock), for a lease-status answer to another daemon (#11200).
   */
  isUnderShutdownReservation(deviceId: string): boolean {
    return this.state.shutdownReservationCoordinator.isDeviceUnderShutdownReservation(deviceId);
  }

  /**
   * Whether some acquisition is preparing this device right now and has not bound it yet.
   * Synchronous (no assignment lock): a selector start reads it to prefer another match (#11651).
   */
  isReservedForReadiness(deviceId: string, exceptOwners?: ReadonlySet<symbol>): boolean {
    return this.state.deviceReservations.isReservedForReadiness(deviceId, exceptOwners);
  }

  /**
   * Refuse to select a device another request is still preparing: it holds a live readiness
   * reservation and no session has been bound yet (#11651, owner decision 2026-10-11). Typed
   * `device_owned_by_other_session`, retryable: it ends when that request binds (a held device,
   * with the usual rules) or releases its reservation on failure or cancellation. A device a live
   * session already holds is left to those rules, so its holder re-selecting it while its own
   * start refreshes readiness is not refused. Synchronous, so a caller can also ask before its
   * first side effect; the bind asks again under the assignment mutex. Virtual-device starts
   * are serialised by the lifecycle lease. Physical Android devices have no lease identity,
   * so their starts still race at the bind as before. Internal acquisitions keep the permissive
   * bind default; an opt-in caller may exclude its own reservation owners.
   */
  assertNotPreparedForOtherRequest(deviceId: string, ownReservations?: ReadonlySet<symbol>): void {
    if (!this.callbacks.isReservedForReadiness(deviceId, ownReservations)) {
      return;
    }
    const holder = holderOf(this.state.devices.get(deviceId));
    if (holder && this.state.sessionManager.getSession(holder)) {
      return;
    }
    throw devicePreparedForOtherRequestError(deviceId);
  }

  hasReadinessNameReservation(
    device: PooledDevice,
    readinessReservationOwners?: ReadonlySet<symbol>,
  ): boolean {
    return this.state.deviceReservations.hasReadinessNameReservation(
      device,
      readinessReservationOwners,
    );
  }

  isReservedForShutdown(device: PooledDevice): boolean {
    return this.state.shutdownReservationCoordinator.isReservedForShutdown(device);
  }

  assertReadinessReservationOwner(
    device: PooledDevice,
    client:
      | (AutolockClient & {
          restartResumeSessionId?: string;
        })
      | undefined,
  ): void {
    return this.state.deviceReservations.assertReadinessReservationOwner(device, client);
  }

  assertAndroidRecoveryExclusionForReadinessReservation(
    device: PooledDevice | undefined,
    expectedIdentity: Pick<BootedDevice, "deviceId" | "name" | "platform">,
    stableRuntimeName: string,
    enforceAndroidRecoveryExclusion: boolean,
  ): void {
    return this.state.deviceReservations.assertAndroidRecoveryExclusionForReadinessReservation(
      device,
      expectedIdentity,
      stableRuntimeName,
      enforceAndroidRecoveryExclusion,
    );
  }

  reserveShutdownSessionIdentity(deviceId: string): ShutdownIdentityReservation {
    return this.state.deviceReservations.reserveShutdownSessionIdentity(deviceId);
  }

  reserveMcpSessionRecoveryLease(
    mcpSessionId: string | undefined,
    device: PooledDevice,
    token: symbol | undefined,
  ): void {
    return this.state.deviceReservations.reserveMcpSessionRecoveryLease(
      mcpSessionId,
      device,
      token,
    );
  }

  releaseMcpSessionRecoveryLease(
    mcpSessionId: string | undefined,
    token: symbol | undefined,
  ): void {
    return this.state.deviceReservations.releaseMcpSessionRecoveryLease(mcpSessionId, token);
  }

  transferMcpSessionRecoveryLeases(previous: PooledDevice, replacement: PooledDevice): void {
    return this.state.deviceReservations.transferMcpSessionRecoveryLeases(previous, replacement);
  }

  completeShutdownSessionIdentity(
    deviceId: string,
    device: PooledDevice,
    identity: ShutdownIdentityReservation,
  ): void {
    if (identity.session) {
      return;
    }
    const session = this.state.pooledSessionIdentities.get(device);
    if (
      session?.sessionId !== holderOf(device) ||
      session.assignedDevice !== deviceId ||
      // Every production assignment path holds assignmentMutex. Once this
      // callback owns it, an outer getOrCreateSession assignment can only be
      // awaiting its finally cleanup; it can no longer publish device state.
      !this.state.sessionManager.isLatestSessionIdentity(session, {
        ignorePendingAssignment: true,
      })
    ) {
      return;
    }
    identity.session = session;
    identity.releaseSession = this.state.sessionManager.reserveSessionForTerminalRelease(
      session,
      deviceId,
    );
  }
}

export function connectReservations(
  part: () => DevicePoolReservations,
  seams: Pick<
    DevicePoolOperations,
    | "reserveDeviceForReadiness"
    | "reserveRestartRecoveryReadiness"
    | "reserveDeviceForShutdown"
    | "isUnderShutdownReservation"
    | "isReservedForReadiness"
    | "assertNotPreparedForOtherRequest"
  >,
): ReservationsOperations {
  return {
    clearUnpooledShutdown: (...args) => part().clearUnpooledShutdown(...args),
    fenceUnpooledShutdown: (...args) => part().fenceUnpooledShutdown(...args),
    settleUnpooledShutdown: (...args) => part().settleUnpooledShutdown(...args),
    reserveDeviceForReadiness: (...args) => seams.reserveDeviceForReadiness(...args),
    reserveRestartRecoveryReadiness: (...args) => seams.reserveRestartRecoveryReadiness(...args),
    restartReadinessOwners: (...args) => part().restartReadinessOwners(...args),
    notifyReservationChanged: (...args) => part().notifyReservationChanged(...args),
    notifyingShutdownReservation: (...args) => part().notifyingShutdownReservation(...args),
    reserveDeviceForShutdown: (...args) => seams.reserveDeviceForShutdown(...args),
    claimShutdownAgainstOtherDaemons: (...args) => part().claimShutdownAgainstOtherDaemons(...args),
    isUnderShutdownReservation: (...args) => seams.isUnderShutdownReservation(...args),
    isReservedForReadiness: (...args) => seams.isReservedForReadiness(...args),
    assertNotPreparedForOtherRequest: (...args) => seams.assertNotPreparedForOtherRequest(...args),
    hasReadinessNameReservation: (...args) => part().hasReadinessNameReservation(...args),
    isReservedForShutdown: (...args) => part().isReservedForShutdown(...args),
    assertReadinessReservationOwner: (...args) => part().assertReadinessReservationOwner(...args),
    assertAndroidRecoveryExclusionForReadinessReservation: (...args) =>
      part().assertAndroidRecoveryExclusionForReadinessReservation(...args),
    reserveShutdownSessionIdentity: (...args) => part().reserveShutdownSessionIdentity(...args),
    reserveMcpSessionRecoveryLease: (...args) => part().reserveMcpSessionRecoveryLease(...args),
    releaseMcpSessionRecoveryLease: (...args) => part().releaseMcpSessionRecoveryLease(...args),
    transferMcpSessionRecoveryLeases: (...args) => part().transferMcpSessionRecoveryLeases(...args),
    completeShutdownSessionIdentity: (...args) => part().completeShutdownSessionIdentity(...args),
  };
}
