import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { isErrored, holderOf, isIdle, statusOf } from "../deviceBinding";
import {
  deviceHold,
  holdAllowsObservationServiceStart,
  holdBlocksAssignment,
  type DeviceHoldFacts,
} from "../deviceHold";
import { DeviceShuttingDownError } from "../../models/deviceAcquisitionRefusals";
import { type RehydrationDeviceReservation } from "../sessionManager";
import { Platform } from "../../models";
import type { PooledDevice } from "../devicePoolTypes";
import { RestartStopTargetIdentity } from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface AvailabilityOperations {
  /** Conservative, read-only admission for session-less hierarchy service setup. */
  isSafeForObservationServiceStart(deviceId: string): boolean;
  waitForAssignmentTransition(deviceId: string, signal?: AbortSignal): Promise<boolean>;
  holdFactsFor(
    device: PooledDevice,
    forSessionId?: string,
    consumer?: "assignment" | "generic" | "bucket" | "observation" | "health",
  ): DeviceHoldFacts;
  isReservedForAssignment(device: PooledDevice, forSessionId?: string): boolean;
  isReservedOutsideReadiness(device: PooledDevice, forSessionId?: string): boolean;
  /**
   * Hold each persisted row's device for that row while daemon restart recovery works through
   * the rows (#11294), so an allocation arriving meanwhile cannot take a device a row is about
   * to recover onto. The reservation is by identity, so it also covers a device discovery has
   * not listed yet. A device a broker binding holds is not reserved: the binding wins, and the row
   * recovers or fails through the normal path. When two rows name one device the first keeps it.
   */
  reserveDevicesForRehydration(rows: readonly RehydrationDeviceReservation[]): Promise<void>;
  reserveRehydrationDevices(
    rows: readonly RehydrationDeviceReservation[],
    stillCurrent?: () => boolean,
    restartHandoff?: boolean,
  ): Promise<void>;
  notifyRehydrationReservationChanged(
    target: Pick<RehydrationDeviceReservation["target"], "platform" | "stableDeviceId">,
  ): void;
  scheduleDeviceRestartReservationExpiry(sessionId: string, deadline: number): void;
  releaseDeviceRestartReservation(sessionId: string): void;
  /** End the daemon batch's hold; terminal releases and daemon/pool shutdown end both sources (#11294). */
  releaseRehydrationReservation(sessionId: string, terminal?: boolean): void;
  rehydrationReservationHolder(device: PooledDevice): string | undefined;
  isReservedForOtherRehydration(device: PooledDevice, forSessionId?: string): boolean;
  /** Read-only pre-boot admission, including stopped images; broker bindings retain priority. */
  restartReservationForStart(
    platform: Platform,
    identities: readonly string[],
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
      oneShotCli?: boolean;
    },
  ):
    | {
        sessionUuid: string;
        owned: boolean;
        restartHandoff: boolean;
        target: RehydrationDeviceReservation["target"];
        deviceId: string;
        retryAfterMs: number;
      }
    | undefined;
  startMatchesRestartReservation(
    platform: Platform,
    identities: readonly string[],
    sessionUuid: string,
    target: RehydrationDeviceReservation["target"],
  ): boolean;
  /** Stable and runtime identities a selector must skip before any discovery can boot them. */
  restartReservationExclusions(
    platform: Platform,
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
      oneShotCli?: boolean;
    },
  ): {
    names: ReadonlySet<string>;
    ids: ReadonlySet<string>;
    resumeTargets: readonly RehydrationDeviceReservation[];
  };
  /** A stop naming a restart holder cannot impersonate its handoff connection, even with force. */
  isRestartReservationOwnedByOtherConnection(
    deviceId: string,
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
    identity?: RestartStopTargetIdentity,
  ): boolean;
  restartReservationHasConnectionOwner(
    target:
      | {
          ownerMcpSessionIds?: ReadonlySet<string>;
        }
      | undefined,
    mcpSessionId: string | undefined,
  ): boolean;
  ownsRestartReservation(
    sessionUuid: string,
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
      oneShotCli?: boolean;
    },
  ): boolean;
  assertNotReservedForOtherRehydration(device: PooledDevice, sessionId: string | undefined): void;
  assertNotReservedForShutdown(device: PooledDevice, detail: string): void;
}
type AvailabilityState = Pick<
  DevicePoolState,
  | "timer"
  | "devices"
  | "recoveryCoordinator"
  | "shutdownReservationCoordinator"
  | "assignmentMutex"
  | "deferredDeviceReleases"
  | "sessionManager"
  | "adbServerResetQuarantine"
  | "androidRecoveryRecordLedger"
  | "mcpSessionRecoveryDevices"
  | "lifecycleCoordinator"
  | "androidTransportAliases"
  | "deviceReservations"
>;
export type AvailabilityCallbacks = Pick<
  DevicePoolOperations,
  | "restartReadinessOwners"
  | "isReservedForReadiness"
  | "hasReadinessNameReservation"
  | "isReservedForShutdown"
  | "stableDeviceIdFor"
  | "getRecoveringAndroidTargets"
  | "getDeviceHealthMarker"
  | "isBindingDevice"
  | "isDrivenByForeignDaemon"
>;

/** Availability responsibilities of DevicePool. */
export class DevicePoolAvailability {
  constructor(
    private readonly state: AvailabilityState,
    private readonly callbacks: AvailabilityCallbacks,
  ) {}
  async waitForAssignmentTransition(deviceId: string, signal?: AbortSignal): Promise<boolean> {
    const device = this.state.devices.get(deviceId);
    if (
      !device ||
      !this.state.assignmentMutex.isLocked() ||
      !deviceHold(this.holdFactsFor(device, undefined, "observation")).reasons.every(
        (reason) => reason.kind === "assignment",
      )
    ) {
      return false;
    }
    // A timed-out/aborted caller's waiter stays registered until the next unlock (bounded).
    await raceWithDeadline(() => this.state.assignmentMutex.waitForUnlock(), {
      timer: this.state.timer,
      signal,
      label: "Observer pool assignment transition",
    });
    return true;
  }

  /** Conservative, read-only admission for session-less hierarchy service setup. */
  isSafeForObservationServiceStart(deviceId: string): boolean {
    const device = this.state.devices.get(deviceId);
    return device
      ? holdAllowsObservationServiceStart(
          deviceHold(this.holdFactsFor(device, undefined, "observation")),
        )
      : false;
  }

  /**
   * Snapshot only the facts the named `consumer` read before #11803, then classify them with
   * `deviceHold`. Each consumer keeps its old probe set and order: generic allocation never reads
   * observation recovery targets, and held inventory never probes transport/health. Probes are
   * called on this instance so injected test seams still work.
   */
  holdFactsFor(
    device: PooledDevice,
    forSessionId?: string,
    consumer: "assignment" | "generic" | "bucket" | "observation" | "health" = "assignment",
  ): DeviceHoldFacts {
    const base: DeviceHoldFacts = { status: statusOf(device), sessionId: holderOf(device) };
    const reservationFacts = (): DeviceHoldFacts => {
      const ownReadiness = this.callbacks.restartReadinessOwners(device, forSessionId);
      if (this.callbacks.isReservedForReadiness(device.id, ownReadiness)) {
        return { ...base, readinessById: true };
      }
      if (this.callbacks.hasReadinessNameReservation(device, ownReadiness)) {
        return { ...base, readinessByName: true };
      }
      if (this.state.recoveryCoordinator.isAndroidRecoveryHandoffReserved(device.id)) {
        return { ...base, recoveryHandoff: true };
      }
      if (
        this.callbacks.isReservedForShutdown(device) ||
        this.state.shutdownReservationCoordinator.isDeviceUnderShutdown(device.id)
      ) {
        return { ...base, shutdown: true };
      }
      const holder = this.rehydrationReservationHolder(device);
      return { ...base, rehydrationHolder: holder !== forSessionId ? holder : undefined };
    };
    const observationFacts = (): DeviceHoldFacts => {
      if (holderOf(device) || !isIdle(device)) {
        return base;
      }
      const stableId = this.callbacks.stableDeviceIdFor(device);
      if (stableId === undefined) {
        return { ...base, stableIdentityMissing: true };
      }
      const recovery = this.callbacks.getRecoveringAndroidTargets();
      // The old observation array evaluated every term, even when an earlier term blocked it.
      const assignmentMutexLocked = this.state.assignmentMutex.isLocked();
      const reservations = this.holdFactsFor(device, forSessionId);
      return {
        ...reservations,
        assignmentMutexLocked,
        deferredRelease: this.state.deferredDeviceReleases.has(device.id),
        cleanupInProgress: this.state.sessionManager.hasDeviceCleanupInProgress(device.id),
        sessionForDevice: this.state.sessionManager.getSessionForDevice(device.id) ?? undefined,
        healthMarker: !!this.callbacks.getDeviceHealthMarker(device.id),
        identityUnresolved: !!device.identityUnresolved,
        identityReconcileOwner: device.identityReconcileOwner,
        adbServerResetSessionId: device.adbServerResetSessionId,
        adbStartupLease:
          device.platform === "android" &&
          this.state.adbServerResetQuarantine.isLeasedForAndroidStartup(stableId),
        recoveringSerial: recovery.serials.has(device.id),
        recoveringName: recovery.names.has(device.name),
        recoveringStableId: recovery.names.has(stableId),
        recoveringSessionLoss: Array.from(
          this.state.androidRecoveryRecordLedger.recoveringSessionLosses.values(),
        ).some((record) => record.deviceId === device.id && record.state !== "finalized"),
        mcpSessionRecoveryLease: Array.from(this.state.mcpSessionRecoveryDevices.values()).some(
          (lease) => lease.device === device,
        ),
        lifecycleStableReservation: this.state.lifecycleCoordinator.isReserved({
          kind: "stable",
          platform: device.platform,
          stableId,
        }),
        lifecycleSelectorReservation: this.state.lifecycleCoordinator.isReserved({
          kind: "selector",
          platform: device.platform,
          selector: device.name,
        }),
      };
    };
    const allocationFacts = (): DeviceHoldFacts => {
      if (this.callbacks.isBindingDevice(device)) {
        return { ...base, brokerBinding: true };
      }
      if (this.callbacks.isDrivenByForeignDaemon(device)) {
        return { ...base, foreignDaemon: true };
      }
      const reservations = this.holdFactsFor(device, forSessionId);
      if (consumer === "generic" || holdBlocksAssignment(deviceHold(reservations))) {
        return reservations;
      }
      // isPotentialAllocationSupply's order: error, transport alias, then health marker.
      const transportAliasUnassignable =
        !isErrored(device) &&
        !this.state.androidTransportAliases.isAssignable({
          deviceId: device.id,
          name: device.name,
          platform: device.platform,
        });
      return {
        ...reservations,
        transportAliasUnassignable,
        healthMarker:
          !isErrored(device) &&
          !transportAliasUnassignable &&
          !!this.callbacks.getDeviceHealthMarker(device.id),
      };
    };
    switch (consumer) {
      case "assignment":
        return reservationFacts();
      case "observation":
        return observationFacts();
      case "health":
        return {
          ...base,
          cleanupInProgress:
            isIdle(device) &&
            !holderOf(device) &&
            this.state.sessionManager.hasDeviceCleanupInProgress(device.id),
        };
      case "generic":
      case "bucket":
        return allocationFacts();
    }
  }

  /** Requester-relative restart/readiness exemptions are gathered before classification. */
  isReservedForAssignment(device: PooledDevice, forSessionId?: string): boolean {
    return holdBlocksAssignment(deviceHold(this.holdFactsFor(device, forSessionId)));
  }

  isReservedOutsideReadiness(device: PooledDevice, forSessionId?: string): boolean {
    return this.state.deviceReservations.isReservedOutsideReadiness(device, forSessionId);
  }

  /**
   * Hold each persisted row's device for that row while daemon restart recovery works through
   * the rows (#11294), so an allocation arriving meanwhile cannot take a device a row is about
   * to recover onto. The reservation is by identity, so it also covers a device discovery has
   * not listed yet. A device a broker binding holds is not reserved: the binding wins, and the row
   * recovers or fails through the normal path. When two rows name one device the first keeps it.
   */
  reserveDevicesForRehydration(rows: readonly RehydrationDeviceReservation[]): Promise<void> {
    return this.state.deviceReservations.reserveDevicesForRehydration(rows);
  }

  reserveRehydrationDevices(
    rows: readonly RehydrationDeviceReservation[],
    stillCurrent: () => boolean = () => true,
    restartHandoff = false,
  ): Promise<void> {
    return this.state.deviceReservations.reserveRehydrationDevices(
      rows,
      stillCurrent,
      restartHandoff,
    );
  }

  /** The reserved device's bucket moved, but the reservation names it by identity: tell observers of every match. */
  notifyRehydrationReservationChanged(
    target: Pick<RehydrationDeviceReservation["target"], "platform" | "stableDeviceId">,
  ): void {
    return this.state.deviceReservations.emitRehydrationReservationChanged(target);
  }

  scheduleDeviceRestartReservationExpiry(sessionId: string, deadline: number): void {
    return this.state.deviceReservations.scheduleDeviceRestartReservationExpiry(
      sessionId,
      deadline,
    );
  }

  releaseDeviceRestartReservation(sessionId: string): void {
    return this.state.deviceReservations.releaseDeviceRestartReservation(sessionId);
  }

  /** End the daemon batch's hold; terminal releases and daemon/pool shutdown end both sources (#11294). */
  releaseRehydrationReservation(sessionId: string, terminal = false): void {
    return this.state.deviceReservations.releaseRehydrationReservation(sessionId, terminal);
  }

  /**
   * The session whose restart recovery `device` is reserved for, if any (#11294). A device a
   * broker binding holds is never reserved, whenever the binding took it: the binding wins, and the row
   * recovers or fails (target-busy once the binding's execution is bound) through the normal path.
   */
  rehydrationReservationHolder(device: PooledDevice): string | undefined {
    return this.state.deviceReservations.rehydrationReservationHolder(device);
  }

  isReservedForOtherRehydration(device: PooledDevice, forSessionId?: string): boolean {
    return this.state.deviceReservations.isReservedForOtherRehydration(device, forSessionId);
  }

  /** Read-only pre-boot admission, including stopped images; broker bindings retain priority. */
  restartReservationForStart(
    platform: Platform,
    identities: readonly string[],
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
      oneShotCli?: boolean;
    },
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
    return this.state.deviceReservations.restartReservationForStart(
      platform,
      identities,
      requester,
    );
  }

  startMatchesRestartReservation(
    platform: Platform,
    identities: readonly string[],
    sessionUuid: string,
    target: RehydrationDeviceReservation["target"],
  ): boolean {
    return this.state.deviceReservations.startMatchesRestartReservation(
      platform,
      identities,
      sessionUuid,
      target,
    );
  }

  /** Stable and runtime identities a selector must skip before any discovery can boot them. */
  restartReservationExclusions(
    platform: Platform,
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
      oneShotCli?: boolean;
    },
  ): {
    names: ReadonlySet<string>;
    ids: ReadonlySet<string>;
    resumeTargets: readonly RehydrationDeviceReservation[];
  } {
    return this.state.deviceReservations.restartReservationExclusions(platform, requester);
  }

  /** A stop naming a restart holder cannot impersonate its handoff connection, even with force. */
  isRestartReservationOwnedByOtherConnection(
    deviceId: string,
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
    identity?: RestartStopTargetIdentity,
  ): boolean {
    return this.state.deviceReservations.isRestartReservationOwnedByOtherConnection(
      deviceId,
      requester,
      identity,
    );
  }

  restartReservationHasConnectionOwner(
    target:
      | {
          ownerMcpSessionIds?: ReadonlySet<string>;
        }
      | undefined,
    mcpSessionId: string | undefined,
  ): boolean {
    return this.state.deviceReservations.restartReservationHasConnectionOwner(target, mcpSessionId);
  }

  ownsRestartReservation(
    sessionUuid: string,
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
      oneShotCli?: boolean;
    },
  ): boolean {
    return this.state.deviceReservations.ownsRestartReservation(sessionUuid, requester);
  }

  /** Restart recovery is about to put another session back on `device` (#11294). */
  assertNotReservedForOtherRehydration(device: PooledDevice, sessionId: string | undefined): void {
    return this.state.deviceReservations.assertNotReservedForOtherRehydration(device, sessionId);
  }

  assertNotReservedForShutdown(device: PooledDevice, detail: string): void {
    if (this.callbacks.isReservedForShutdown(device)) {
      throw new DeviceShuttingDownError(device.id, detail);
    }
  }
}

export function connectAvailability(
  part: () => DevicePoolAvailability,
  seams: Pick<
    DevicePoolOperations,
    | "waitForAssignmentTransition"
    | "isSafeForObservationServiceStart"
    | "reserveDevicesForRehydration"
    | "notifyRehydrationReservationChanged"
    | "releaseRehydrationReservation"
    | "restartReservationForStart"
    | "restartReservationExclusions"
    | "isRestartReservationOwnedByOtherConnection"
  >,
): AvailabilityOperations {
  return {
    waitForAssignmentTransition: (...args) => seams.waitForAssignmentTransition(...args),
    isSafeForObservationServiceStart: (...args) => seams.isSafeForObservationServiceStart(...args),
    holdFactsFor: (...args) => part().holdFactsFor(...args),
    isReservedForAssignment: (...args) => part().isReservedForAssignment(...args),
    isReservedOutsideReadiness: (...args) => part().isReservedOutsideReadiness(...args),
    reserveDevicesForRehydration: (...args) => seams.reserveDevicesForRehydration(...args),
    reserveRehydrationDevices: (...args) => part().reserveRehydrationDevices(...args),
    notifyRehydrationReservationChanged: (...args) =>
      seams.notifyRehydrationReservationChanged(...args),
    scheduleDeviceRestartReservationExpiry: (...args) =>
      part().scheduleDeviceRestartReservationExpiry(...args),
    releaseDeviceRestartReservation: (...args) => part().releaseDeviceRestartReservation(...args),
    releaseRehydrationReservation: (...args) => seams.releaseRehydrationReservation(...args),
    rehydrationReservationHolder: (...args) => part().rehydrationReservationHolder(...args),
    isReservedForOtherRehydration: (...args) => part().isReservedForOtherRehydration(...args),
    restartReservationForStart: (...args) => seams.restartReservationForStart(...args),
    startMatchesRestartReservation: (...args) => part().startMatchesRestartReservation(...args),
    restartReservationExclusions: (...args) => seams.restartReservationExclusions(...args),
    isRestartReservationOwnedByOtherConnection: (...args) =>
      seams.isRestartReservationOwnedByOtherConnection(...args),
    restartReservationHasConnectionOwner: (...args) =>
      part().restartReservationHasConnectionOwner(...args),
    ownsRestartReservation: (...args) => part().ownsRestartReservation(...args),
    assertNotReservedForOtherRehydration: (...args) =>
      part().assertNotReservedForOtherRehydration(...args),
    assertNotReservedForShutdown: (...args) => part().assertNotReservedForShutdown(...args),
  };
}
