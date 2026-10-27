import { isBusy, isIdle } from "../deviceBinding";
import { DevicePoolError } from "../DevicePoolError";
import {
  SessionRecoveryIdentityLossError,
  type RehydrationDeviceReservation,
  type SessionRecoveryTarget,
} from "../sessionManager";
import { BootedDevice, Platform } from "../../models";
import { isUnresolvedAndroidEmulatorName } from "../../devices/deviceIdentityEvidence";
import { didSourceSucceedForDevice, type DiscoveryCompleteness } from "../../utils/discoverySource";
import type { PooledDevice } from "../devicePoolTypes";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface RecoveryEvidenceOperations {
  /** Use the same stable identity as persisted recovery, including serial-only Android handsets. */
  matchesRestartRecoveryTarget(
    device: BootedDevice,
    target: RehydrationDeviceReservation["target"],
  ): boolean;
  getDevicesMatchingRecoveryTarget(target: SessionRecoveryTarget): PooledDevice[];
  recoveryFailure(
    sessionId: string,
    target: SessionRecoveryTarget,
    refreshCompleteness?: DiscoveryCompleteness,
  ): SessionRecoveryIdentityLossError | DevicePoolError | undefined;
  reusedTransportRecoveryFailure(
    sessionId: string,
    target: SessionRecoveryTarget,
  ): DevicePoolError | SessionRecoveryIdentityLossError;
  isRestartRecoveryPending(target: SessionRecoveryTarget): boolean;
  recoveryBusyFailure(
    sessionId: string,
    target: SessionRecoveryTarget,
    exact: PooledDevice,
  ): SessionRecoveryIdentityLossError | DevicePoolError | undefined;
  recoveryWaitingForReadiness(
    device: PooledDevice,
    sessionId: string,
    target: SessionRecoveryTarget,
  ): boolean;
  recoveryDiscoveryEvidence(
    target: SessionRecoveryTarget,
    platformDevices: PooledDevice[],
    refreshCompleteness: DiscoveryCompleteness | undefined,
  ): {
    transportReused: boolean;
    transportIdentityUnresolved: boolean;
    absenceAuthoritative: boolean;
  };
  stableDeviceIdFor(
    device: Pick<PooledDevice, "id" | "name" | "platform" | "avdName" | "identityUnresolved">,
  ): string | undefined;
  getDevicesByPlatform(platform?: Platform): PooledDevice[];
}
type RecoveryEvidenceState = Pick<DevicePoolState, "devices">;
export type RecoveryEvidenceCallbacks = Pick<
  DevicePoolOperations,
  | "isPooledAndroidEmulator"
  | "recoveryNow"
  | "isReservedForAssignment"
  | "isReservedOutsideReadiness"
  | "getAllDevices"
>;

/** Recovery Evidence responsibilities of DevicePool. */
export class DevicePoolRecoveryEvidence {
  constructor(
    private readonly state: RecoveryEvidenceState,
    private readonly callbacks: RecoveryEvidenceCallbacks,
  ) {}
  /** Use the same stable identity as persisted recovery, including serial-only Android handsets. */
  matchesRestartRecoveryTarget(
    device: BootedDevice,
    target: RehydrationDeviceReservation["target"],
  ): boolean {
    const pooled = this.state.devices.get(device.deviceId);
    const emulator = this.callbacks.isPooledAndroidEmulator(device.deviceId);
    const stableId = this.stableDeviceIdFor(
      pooled ?? {
        id: device.deviceId,
        name: device.name,
        platform: device.platform,
      },
    );
    return (
      device.platform === target.platform &&
      stableId === target.stableDeviceId &&
      (target.androidEmulator === undefined || emulator === target.androidEmulator)
    );
  }

  getDevicesMatchingRecoveryTarget(target: SessionRecoveryTarget): PooledDevice[] {
    const matches = this.getDevicesByPlatform(target.platform).filter(
      (device) =>
        this.stableDeviceIdFor(device) === target.stableDeviceId &&
        (target.androidEmulator === undefined ||
          this.callbacks.isPooledAndroidEmulator(device.id) === target.androidEmulator),
    );
    // A recovery target must prove one exact runtime. A duplicate stable identity
    // is ambiguous and must not collapse back to normal pool selection.
    return matches.length === 1 ? matches : [];
  }

  /**
   * Recovery is an identity operation, not ordinary pool allocation. Once an
   * exact target is absent, busy, or replaced at its old transport address,
   * fail immediately rather than allowing retry timing or discovery order to
   * choose another signed device. A device-restart release has a persisted,
   * bounded grace period for absence, including another runtime at its old transport.
   * An unresolved emulator identity at any
   * serial is not evidence of absence or replacement.
   */
  recoveryFailure(
    sessionId: string,
    target: SessionRecoveryTarget,
    refreshCompleteness?: DiscoveryCompleteness,
  ): SessionRecoveryIdentityLossError | DevicePoolError | undefined {
    const platformDevices = this.getDevicesByPlatform(target.platform);
    const exactMatches = platformDevices.filter(
      (device) =>
        this.stableDeviceIdFor(device) === target.stableDeviceId &&
        (target.androidEmulator === undefined ||
          this.callbacks.isPooledAndroidEmulator(device.id) === target.androidEmulator),
    );
    if (exactMatches.length !== 1) {
      const { transportReused, transportIdentityUnresolved, absenceAuthoritative } =
        this.recoveryDiscoveryEvidence(target, platformDevices, refreshCompleteness);
      if (exactMatches.length > 1) {
        return new SessionRecoveryIdentityLossError(sessionId, target, "identity-continuity-lost");
      }
      if (transportReused) {
        return this.reusedTransportRecoveryFailure(sessionId, target);
      }
      if (transportIdentityUnresolved) {
        if (
          target.restartRecoveryDeadlineMs === undefined ||
          this.isRestartRecoveryPending(target)
        ) {
          return new DevicePoolError("Recovery target identity is unresolved", true);
        }
      }
      if (!absenceAuthoritative) {
        return new DevicePoolError("Recovery target absence is not yet authoritative", true);
      }
      if (this.isRestartRecoveryPending(target)) {
        return new DevicePoolError("Recovery target is restarting", true);
      }
      return new SessionRecoveryIdentityLossError(sessionId, target, "target-absent");
    }
    return this.recoveryBusyFailure(sessionId, target, exactMatches[0]);
  }

  reusedTransportRecoveryFailure(
    sessionId: string,
    target: SessionRecoveryTarget,
  ): DevicePoolError | SessionRecoveryIdentityLossError {
    if (this.isRestartRecoveryPending(target)) {
      return new DevicePoolError("Recovery target is restarting", true);
    }
    return new SessionRecoveryIdentityLossError(
      sessionId,
      target,
      target.restartRecoveryDeadlineMs === undefined ? "identity-continuity-lost" : "target-absent",
    );
  }

  isRestartRecoveryPending(target: SessionRecoveryTarget): boolean {
    return (
      target.restartRecoveryDeadlineMs !== undefined &&
      this.callbacks.recoveryNow() < target.restartRecoveryDeadlineMs
    );
  }

  recoveryBusyFailure(
    sessionId: string,
    target: SessionRecoveryTarget,
    exact: PooledDevice,
  ): SessionRecoveryIdentityLossError | DevicePoolError | undefined {
    // A restart-recovery reservation made for this very row is not "busy" (#11294).
    if (isBusy(exact) || this.callbacks.isReservedForAssignment(exact, sessionId)) {
      if (this.recoveryWaitingForReadiness(exact, sessionId, target)) {
        return new DevicePoolError("Recovery target is being prepared", true);
      }
      return new SessionRecoveryIdentityLossError(sessionId, target, "target-busy");
    }
    return undefined;
  }

  recoveryWaitingForReadiness(
    device: PooledDevice,
    sessionId: string,
    target: SessionRecoveryTarget,
  ): boolean {
    // A request preparing an unheld target is temporary contention, not loss of R's identity.
    // Keep waiting within the original bounds; never bypass that request's readiness symbols.
    return (
      isIdle(device) &&
      target.restartRecoveryDeadlineMs !== undefined &&
      this.callbacks.recoveryNow() < target.restartRecoveryDeadlineMs &&
      !this.callbacks.isReservedOutsideReadiness(device, sessionId)
    );
  }

  recoveryDiscoveryEvidence(
    target: SessionRecoveryTarget,
    platformDevices: PooledDevice[],
    refreshCompleteness: DiscoveryCompleteness | undefined,
  ): {
    transportReused: boolean;
    transportIdentityUnresolved: boolean;
    absenceAuthoritative: boolean;
  } {
    const transportReused = platformDevices.some((device) => {
      const stableId = this.stableDeviceIdFor(device);
      return (
        device.id === target.deviceId &&
        stableId !== undefined &&
        stableId !== target.stableDeviceId
      );
    });
    const transportIdentityUnresolved =
      !isUnresolvedAndroidEmulatorName({
        deviceId: target.deviceId,
        name: target.stableDeviceId,
        platform: target.platform,
      }) &&
      platformDevices.some(
        (device) =>
          this.stableDeviceIdFor(device) === undefined &&
          (device.id === target.deviceId ||
            (target.platform === "android" &&
              target.androidEmulator === true &&
              this.callbacks.isPooledAndroidEmulator(device.id))),
      );
    const absenceAuthoritative =
      refreshCompleteness !== undefined &&
      didSourceSucceedForDevice(refreshCompleteness, target.platform, target.deviceId);
    return { transportReused, transportIdentityUnresolved, absenceAuthoritative };
  }

  stableDeviceIdFor(
    device: Pick<PooledDevice, "id" | "name" | "platform" | "avdName" | "identityUnresolved">,
  ): string | undefined {
    if (device.platform === "ios") {
      return device.id;
    }
    if (!this.callbacks.isPooledAndroidEmulator(device.id)) {
      return device.id;
    }
    return (
      device.avdName ??
      (device.identityUnresolved ||
      isUnresolvedAndroidEmulatorName({
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
      })
        ? undefined
        : device.name)
    );
  }

  getDevicesByPlatform(platform?: Platform): PooledDevice[] {
    if (!platform) {
      return this.callbacks.getAllDevices();
    }
    return this.state.devices.byPlatform(platform);
  }
}

export function connectRecoveryEvidence(
  part: () => DevicePoolRecoveryEvidence,
  seams: Pick<DevicePoolOperations, "matchesRestartRecoveryTarget">,
): RecoveryEvidenceOperations {
  return {
    matchesRestartRecoveryTarget: (...args) => seams.matchesRestartRecoveryTarget(...args),
    getDevicesMatchingRecoveryTarget: (...args) => part().getDevicesMatchingRecoveryTarget(...args),
    recoveryFailure: (...args) => part().recoveryFailure(...args),
    reusedTransportRecoveryFailure: (...args) => part().reusedTransportRecoveryFailure(...args),
    isRestartRecoveryPending: (...args) => part().isRestartRecoveryPending(...args),
    recoveryBusyFailure: (...args) => part().recoveryBusyFailure(...args),
    recoveryWaitingForReadiness: (...args) => part().recoveryWaitingForReadiness(...args),
    recoveryDiscoveryEvidence: (...args) => part().recoveryDiscoveryEvidence(...args),
    stableDeviceIdFor: (...args) => part().stableDeviceIdFor(...args),
    getDevicesByPlatform: (...args) => part().getDevicesByPlatform(...args),
  };
}
