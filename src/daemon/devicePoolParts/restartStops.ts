import {} from "../deviceBinding";
import { type DeviceRehydrationReservation } from "../deviceReservations";
import { logger } from "../../utils/logger";
import { Platform } from "../../models";
import {
  DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS,
  isSameHolderSession,
} from "../inputDeviceOwnership";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { INCARNATION_ANY } from "../deviceDisconnectHandler";
import type { PooledDevice } from "../devicePoolTypes";
import { RestartStopTargetIdentity } from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface RestartStopsOperations {
  /** Capture restart holds before marking the current Android incarnation for shutdown. */
  markIntentionalShutdown(
    deviceId: string,
    stoppingSessionId?: string,
    options?: RestartStopTargetIdentity & {
      mcpSessionId?: string;
    },
  ): () => void | Promise<void>;
  /** Capture a success-only commit; a sessionless stop also terminalizes the handoff row. */
  releaseDeviceRestartReservationForStop(
    deviceId: string,
    stoppingSessionId?: string,
    options?: RestartStopTargetIdentity & {
      mcpSessionId?: string;
    },
  ): () => void | Promise<void>;
  restartReservationsForStop(
    deviceId: string,
    identity?: RestartStopTargetIdentity,
    ownerRequester?: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
  ): [string, DeviceRehydrationReservation][];
  restartStopStableIdentity(
    deviceId: string,
    identity?: RestartStopTargetIdentity,
  ): {
    platform: Platform | undefined;
    stableIds: readonly string[];
  };
  /** Ordinary stops incur no identity probe when this platform has no restart handoff. */
  hasRestartHandoffReservation(platform: Platform): boolean;
  /** Pool/boot evidence, never the caller's label. Reset-cohort identity retains precedence. */
  restartStopConfirmedPooledIdentity(deviceId: string, platform?: Platform): string | undefined;
  /** An unresolved target might be reserved; only an owner acting on its own hold can proceed. */
  hasUnconfirmedRestartStopReservation(
    deviceId: string,
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
    identity: RestartStopTargetIdentity,
  ): boolean;
  /** Synchronous stop admission uses the same captured target identities as the success commit. */
  restartReservationForStop(
    deviceId: string,
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
    identity?: RestartStopTargetIdentity,
  ):
    | { sessionUuid: string; owned: boolean; foreignConnection: boolean; retryAfterMs: number }
    | undefined;
  ownsRestartReservationForStop(
    sessionUuid: string,
    target: {
      ownerMcpSessionIds?: ReadonlySet<string>;
    },
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
  ): boolean;
  /** Plain lifecycle tools need not carry implicit autolock routing (server/index.ts). */
  restartStopConnectionHasLiveSession(mcpSessionId: string | undefined): boolean;
  dropStoppedDeviceRestartReservations(
    reservations: ReturnType<DevicePoolOperations["restartReservationsForStop"]>,
    owners: ReadonlySet<ReturnType<DevicePoolOperations["restartReservationsForStop"]>[number][1]>,
  ): void | Promise<void>;
  terminalizeStoppedRestartReservation(
    sessionId: string,
    target: ReturnType<DevicePoolOperations["restartReservationsForStop"]>[number][1],
  ): Promise<void>;
  restartStopNamesForeignConnection(
    sessionId: string,
    target: {
      ownerMcpSessionIds?: ReadonlySet<string>;
    },
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
  ): boolean;
  clearIntentionalShutdown(deviceId: string): void;
  /** Permit a later fresh booted observation to lift a timed-out kill's fence. */
  noteLatePlatformShutdownSettled(expectedDevice: PooledDevice): void;
}
type RestartStopsState = Pick<
  DevicePoolState,
  | "sessionManager"
  | "adbServerResetRecoveryReservations"
  | "devices"
  | "intentionalShutdowns"
  | "shutdownReservationCoordinator"
  | "settledLateShutdowns"
  | "recoveryCoordinator"
  | "rehydrationReservations"
  | "bindingExclusion"
  | "mcpSessionAcquiredDeviceSessions"
  | "refreshCoordinator"
>;
export type RestartStopsCallbacks = Pick<
  DevicePoolOperations,
  | "releaseDeviceRestartReservationForStop"
  | "restartStopConnectionHasLiveSession"
  | "restartStopConfirmedPooledIdentity"
  | "stableDeviceIdFor"
  | "restartReservationHasConnectionOwner"
  | "captureAutolockSessionForMcpSession"
  | "releaseDeviceRestartReservation"
  | "releaseRehydrationReservation"
  | "isPooledEntryCurrent"
>;

/** Restart Stops responsibilities of DevicePool. */
export class DevicePoolRestartStops {
  constructor(
    private readonly state: RestartStopsState,
    private readonly callbacks: RestartStopsCallbacks,
  ) {}
  /** Capture restart holds before marking the current Android incarnation for shutdown. */
  markIntentionalShutdown(
    deviceId: string,
    stoppingSessionId?: string,
    options?: RestartStopTargetIdentity & {
      mcpSessionId?: string;
    },
  ): () => void | Promise<void> {
    this.state.sessionManager.flushDeferredRebindCleanups({ deviceId });
    const commitRestartHoldStop = this.callbacks.releaseDeviceRestartReservationForStop(
      deviceId,
      stoppingSessionId,
      options,
    );
    const resetReservation = Array.from(
      this.state.adbServerResetRecoveryReservations.values(),
    ).find((reservation) => reservation.deviceId === deviceId);
    if (resetReservation) {
      // Reset-cohort identity wins over a serial recovery may already have reused.
      resetReservation.cancelled = true;
      return commitRestartHoldStop;
    }
    const device = this.state.devices.get(deviceId);
    if (device) {
      // Tie the marker to the incarnation present now, so a later same-serial
      // replacement is not treated as intentionally stopped.
      this.state.intentionalShutdowns.set(deviceId, device.incarnation);
      this.state.settledLateShutdowns.delete(deviceId);
      return commitRestartHoldStop;
    }
    if (this.state.recoveryCoordinator.recoveringAndroidDeviceIds.has(deviceId)) {
      // No pooled device yet (an in-flight recovery owns the serial); the mark
      // applies to whatever incarnation the recovery produces.
      this.state.intentionalShutdowns.set(deviceId, INCARNATION_ANY);
    }
    return commitRestartHoldStop;
  }

  /** Capture a success-only commit; a sessionless stop also terminalizes the handoff row. */
  releaseDeviceRestartReservationForStop(
    deviceId: string,
    stoppingSessionId?: string,
    options?: RestartStopTargetIdentity & {
      mcpSessionId?: string;
    },
  ): () => void | Promise<void> {
    const requester = { sessionUuid: stoppingSessionId, mcpSessionId: options?.mcpSessionId };
    const sessionless =
      !stoppingSessionId &&
      !this.callbacks.restartStopConnectionHasLiveSession(requester.mcpSessionId);
    const reservations = this.restartReservationsForStop(deviceId, options, requester).filter(
      ([sessionId, target]) =>
        sessionless || this.ownsRestartReservationForStop(sessionId, target, requester),
    );
    const owners = new Set(
      reservations
        .filter(([sessionId, target]) =>
          this.ownsRestartReservationForStop(sessionId, target, requester),
        )
        .map(([, target]) => target),
    );
    return () => this.dropStoppedDeviceRestartReservations(reservations, owners);
  }

  restartReservationsForStop(
    deviceId: string,
    identity?: RestartStopTargetIdentity,
    ownerRequester?: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
  ) {
    const stopIdentity = this.restartStopStableIdentity(deviceId, identity);
    return Array.from(this.state.rehydrationReservations).filter(([sessionId, target]) => {
      if (!target.restartHandoff) {
        return false;
      }
      const stableMatch =
        (stopIdentity.platform === undefined || target.platform === stopIdentity.platform) &&
        stopIdentity.stableIds.includes(target.stableDeviceId);
      // Unknown serial-only stops may drop the owner's own hold, never another session's row.
      const ownSerialMatch =
        stopIdentity.stableIds.length === 0 &&
        target.deviceId === deviceId &&
        ownerRequester !== undefined &&
        this.ownsRestartReservationForStop(sessionId, target, ownerRequester);
      return (
        (stableMatch || ownSerialMatch) &&
        !this.state.bindingExclusion?.holderOf({
          platform: target.platform,
          stableIds: [target.stableDeviceId, target.deviceId],
        })
      );
    });
  }

  restartStopStableIdentity(
    deviceId: string,
    identity?: RestartStopTargetIdentity,
  ): {
    platform: Platform | undefined;
    stableIds: readonly string[];
  } {
    const platform = identity?.platform ?? this.state.devices.get(deviceId)?.platform;
    if (identity?.stopIdentity) {
      return {
        platform,
        stableIds: "confirmed" in identity.stopIdentity ? [identity.stopIdentity.confirmed] : [],
      };
    }
    const confirmed = this.callbacks.restartStopConfirmedPooledIdentity(deviceId, platform);
    return { platform, stableIds: confirmed === undefined ? [] : [confirmed] };
  }

  /** Ordinary stops incur no identity probe when this platform has no restart handoff. */
  hasRestartHandoffReservation(platform: Platform): boolean {
    return [...this.state.rehydrationReservations.values()].some(
      (target) => target.restartHandoff && target.platform === platform,
    );
  }

  /** Pool/boot evidence, never the caller's label. Reset-cohort identity retains precedence. */
  restartStopConfirmedPooledIdentity(deviceId: string, platform?: Platform): string | undefined {
    const resetReservation = [...this.state.adbServerResetRecoveryReservations.values()].find(
      (reservation) => reservation.deviceId === deviceId,
    );
    if (resetReservation) {
      return resetReservation.image.name;
    }
    const device = this.state.devices.get(deviceId);
    if (device?.identityUnresolved) {
      return undefined;
    }
    if (device) {
      return this.callbacks.stableDeviceIdFor(device);
    }
    return platform === "ios" || (platform === "android" && !isAndroidEmulatorSerial(deviceId))
      ? deviceId
      : undefined;
  }

  /** An unresolved target might be reserved; only an owner acting on its own hold can proceed. */
  hasUnconfirmedRestartStopReservation(
    deviceId: string,
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
    identity: RestartStopTargetIdentity,
  ): boolean {
    return [...this.state.rehydrationReservations].some(
      ([sessionId, target]) =>
        target.restartHandoff &&
        target.platform === identity.platform &&
        (target.deviceId === deviceId || identity.stableIds?.includes(target.stableDeviceId)) &&
        (!this.ownsRestartReservationForStop(sessionId, target, requester) ||
          this.restartStopNamesForeignConnection(sessionId, target, requester)),
    );
  }

  /** Synchronous stop admission uses the same captured target identities as the success commit. */
  restartReservationForStop(
    deviceId: string,
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
    identity?: RestartStopTargetIdentity,
  ) {
    const reservation = this.restartReservationsForStop(deviceId, identity)[0];
    if (!reservation) {
      return undefined;
    }
    const [sessionUuid, target] = reservation;
    return {
      sessionUuid,
      owned: this.ownsRestartReservationForStop(sessionUuid, target, requester),
      foreignConnection: this.restartStopNamesForeignConnection(sessionUuid, target, requester),
      retryAfterMs:
        target.scheduledDeadlineMs === undefined
          ? DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS
          : Math.max(1, target.scheduledDeadlineMs - this.state.sessionManager.sessionNow()),
    };
  }

  ownsRestartReservationForStop(
    sessionUuid: string,
    target: {
      ownerMcpSessionIds?: ReadonlySet<string>;
    },
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
  ): boolean {
    return requester.sessionUuid !== undefined
      ? isSameHolderSession(sessionUuid, requester.sessionUuid, this.state.sessionManager)
      : this.callbacks.restartReservationHasConnectionOwner(target, requester.mcpSessionId);
  }

  /** Plain lifecycle tools need not carry implicit autolock routing (server/index.ts). */
  restartStopConnectionHasLiveSession(mcpSessionId: string | undefined): boolean {
    if (!mcpSessionId) {
      return false;
    }
    const sessions = this.state.mcpSessionAcquiredDeviceSessions.get(mcpSessionId);
    const autolock = this.callbacks.captureAutolockSessionForMcpSession(mcpSessionId);
    const ownsLiveSession = (sessionId: string) => {
      const session = this.state.sessionManager.peekSession(sessionId);
      return session !== null && this.state.sessionManager.isAdmittedForAutomation(session);
    };
    return (
      (autolock !== undefined && ownsLiveSession(autolock)) ||
      (sessions !== undefined && [...sessions].some(ownsLiveSession))
    );
  }

  dropStoppedDeviceRestartReservations(
    reservations: ReturnType<DevicePoolOperations["restartReservationsForStop"]>,
    owners: ReadonlySet<ReturnType<DevicePoolOperations["restartReservationsForStop"]>[number][1]>,
  ): void | Promise<void> {
    const terminalWrites: Promise<void>[] = [];
    for (const [sessionId, target] of reservations) {
      // Commit only mark-time objects: a new hold or a recycled serial must survive.
      if (this.state.rehydrationReservations.get(sessionId) !== target || !target.restartHandoff) {
        continue;
      }
      if (owners.has(target)) {
        this.callbacks.releaseDeviceRestartReservation(sessionId);
      } else {
        terminalWrites.push(this.terminalizeStoppedRestartReservation(sessionId, target));
      }
    }
    if (terminalWrites.length > 0) {
      return Promise.all(terminalWrites).then(() => {});
    }
  }

  async terminalizeStoppedRestartReservation(
    sessionId: string,
    target: ReturnType<DevicePoolOperations["restartReservationsForStop"]>[number][1],
  ): Promise<void> {
    try {
      await this.state.sessionManager.terminalizeDeviceRestartHandoffForStop(sessionId);
    } catch (error) {
      logger.warn(
        `[DevicePool] Failed to terminalize stopped restart holder ${sessionId}: ${error}`,
        error,
      );
    } finally {
      // A replacement installed while persistence awaited is not this stop's hold.
      if (this.state.rehydrationReservations.get(sessionId) === target && target.restartHandoff) {
        this.callbacks.releaseRehydrationReservation(sessionId, true);
      }
    }
  }

  restartStopNamesForeignConnection(
    sessionId: string,
    target: {
      ownerMcpSessionIds?: ReadonlySet<string>;
    },
    requester: {
      sessionUuid?: string;
      mcpSessionId?: string;
    },
  ): boolean {
    return (
      requester.mcpSessionId !== undefined &&
      isSameHolderSession(sessionId, requester.sessionUuid, this.state.sessionManager) &&
      (target.ownerMcpSessionIds?.size ?? 0) > 0 &&
      !this.callbacks.restartReservationHasConnectionOwner(target, requester.mcpSessionId)
    );
  }

  clearIntentionalShutdown(deviceId: string): void {
    this.state.shutdownReservationCoordinator.clearUnpooledShutdown(deviceId);
    this.state.intentionalShutdowns.delete(deviceId);
    this.state.settledLateShutdowns.delete(deviceId);
  }

  /** Permit a later fresh booted observation to lift a timed-out kill's fence. */
  noteLatePlatformShutdownSettled(expectedDevice: PooledDevice): void {
    if (
      !this.callbacks.isPooledEntryCurrent(expectedDevice) ||
      this.state.intentionalShutdowns.get(expectedDevice.id) !== expectedDevice.incarnation
    ) {
      return;
    }
    this.state.settledLateShutdowns.set(expectedDevice.id, {
      incarnation: expectedDevice.incarnation,
      refreshGeneration: this.state.refreshCoordinator.getRefreshGeneration(),
    });
  }
}

export function connectRestartStops(
  part: () => DevicePoolRestartStops,
  seams: Pick<
    DevicePoolOperations,
    | "markIntentionalShutdown"
    | "releaseDeviceRestartReservationForStop"
    | "hasRestartHandoffReservation"
    | "restartStopConfirmedPooledIdentity"
    | "hasUnconfirmedRestartStopReservation"
    | "restartReservationForStop"
    | "restartStopConnectionHasLiveSession"
    | "clearIntentionalShutdown"
    | "noteLatePlatformShutdownSettled"
  >,
): RestartStopsOperations {
  return {
    markIntentionalShutdown: (...args) => seams.markIntentionalShutdown(...args),
    releaseDeviceRestartReservationForStop: (...args) =>
      seams.releaseDeviceRestartReservationForStop(...args),
    restartReservationsForStop: (...args) => part().restartReservationsForStop(...args),
    restartStopStableIdentity: (...args) => part().restartStopStableIdentity(...args),
    hasRestartHandoffReservation: (...args) => seams.hasRestartHandoffReservation(...args),
    restartStopConfirmedPooledIdentity: (...args) =>
      seams.restartStopConfirmedPooledIdentity(...args),
    hasUnconfirmedRestartStopReservation: (...args) =>
      seams.hasUnconfirmedRestartStopReservation(...args),
    restartReservationForStop: (...args) => seams.restartReservationForStop(...args),
    ownsRestartReservationForStop: (...args) => part().ownsRestartReservationForStop(...args),
    restartStopConnectionHasLiveSession: (...args) =>
      seams.restartStopConnectionHasLiveSession(...args),
    dropStoppedDeviceRestartReservations: (...args) =>
      part().dropStoppedDeviceRestartReservations(...args),
    terminalizeStoppedRestartReservation: (...args) =>
      part().terminalizeStoppedRestartReservation(...args),
    restartStopNamesForeignConnection: (...args) =>
      part().restartStopNamesForeignConnection(...args),
    clearIntentionalShutdown: (...args) => seams.clearIntentionalShutdown(...args),
    noteLatePlatformShutdownSettled: (...args) => seams.noteLatePlatformShutdownSettled(...args),
  };
}
