import { unbindDevice, holderOf, isIdle } from "../deviceBinding";
import { type PooledDevicePresenceOptions } from "../deviceAllocation";
import type { SessionReleaseReason } from "../releaseReasons";
import { isSessionReleasing } from "../sessionReleaseState";
import { logger } from "../../utils/logger";
import { BootedDevice, Platform } from "../../models";
import { type BootedDeviceDiscovery } from "../../devices/deviceUtils";
import {
  deviceRestartReleaseReason,
  isDeviceRestartReleaseReason,
} from "../../db/deviceSessionRepository";
import {
  compareIdentityEvidence,
  deriveEvidenceFromPooledDevice,
} from "../../devices/deviceIdentityEvidence";
import { deviceLossCancellationReason } from "../emulatorLossIncident";
import { type MissingDeviceEvictionOptions } from "../missingDeviceLiveness";
import { type AndroidEmulatorRecoveryOptions } from "../androidRebootCoordinator";
import type { PooledDevice } from "../devicePoolTypes";
import { AndroidEmulatorRecoveryDevice } from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface PresenceOperations {
  evictUnavailableIdleDevicesMatching(matches: (device: PooledDevice) => boolean): Promise<number>;
  ensurePooledDevicePresentForUse(
    device: PooledDevice,
    options?: PooledDevicePresenceOptions,
  ): Promise<boolean>;
  restartReleaseReasonForIdentityReplacement(
    device: PooledDevice,
    observation?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ): SessionReleaseReason | undefined;
  dropRebindCleanupHold(device: PooledDevice, sessionId: string): boolean;
  releaseSessionForEvictedDevice(
    device: PooledDevice,
    incidentId: string | undefined,
    identityObservation?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ): Promise<boolean>;
  releaseSerialReuseRecoverySession(
    device: PooledDevice,
    sessionId: string,
    releaseReason: SessionReleaseReason,
    attempt: () => Promise<boolean | void>,
  ): Promise<boolean | void>;
  discardReleasedCapture(sessionId: string, deviceId: string): void;
  tryPreserveSessionForMissingDevice(
    device: PooledDevice,
    attemptDeviceLossRecovery: boolean,
    incidentId: string | undefined,
  ): Promise<boolean>;
  shouldValidatePooledDevicePresence(device: PooledDevice): boolean;
  /** Whether this pooled entry uses an Android emulator serial that can be reassigned. */
  hasReusableSerial(device: PooledDevice): boolean;
  takeFreshPresenceDiscovery(platform: Platform): Promise<BootedDeviceDiscovery>;
  evictMissingPooledDevice(
    device: PooledDevice,
    reason: string,
    options?: MissingDeviceEvictionOptions,
  ): Promise<void>;
  shouldRebootDisconnectedAndroidDevice(
    device: PooledDevice,
    options?: AndroidEmulatorRecoveryOptions,
  ): device is AndroidEmulatorRecoveryDevice;
}
type PresenceState = Pick<
  DevicePoolState,
  | "devices"
  | "missingDeviceLiveness"
  | "runtimeIdentity"
  | "sessionManager"
  | "intentionallyCancelledRecoverySessions"
  | "deferredDeviceReleases"
  | "releaseSessionForDisconnectedDevice"
  | "cancelDeviceSessionExecutions"
  | "ambientExecutionIdReader"
  | "releasedDeviceCaptures"
  | "recoveryCoordinator"
>;
export type PresenceCallbacks = Pick<
  DevicePoolOperations,
  | "hasReusableSerial"
  | "matchesRuntimeIdentity"
  | "stableDeviceIdFor"
  | "notifyDeviceStateChanged"
  | "retrySessionRelease"
  | "isPooledEntryCurrent"
  | "finishEmulatorLossIncident"
  | "recordEmulatorLossIncident"
  | "releaseDisconnectedRecoverySessionWithRetry"
  | "completeEmulatorLossRecovery"
  | "settleEmulatorLossIncident"
  | "isSessionPreservingBinding"
  | "recoverSessionBoundDeviceAfterLoss"
  | "getRecoveryPolicy"
  | "isAndroidEmulatorActiveRelaunchEligible"
>;

/** Presence responsibilities of DevicePool. */
export class DevicePoolPresence {
  constructor(
    private readonly state: PresenceState,
    private readonly callbacks: PresenceCallbacks,
  ) {}
  async evictUnavailableIdleDevicesMatching(
    matches: (device: PooledDevice) => boolean,
  ): Promise<number> {
    let evicted = 0;
    for (const device of this.state.devices.all()) {
      if (!isIdle(device) || !matches(device)) {
        continue;
      }
      if (!(await this.ensurePooledDevicePresentForUse(device, { idleEviction: true }))) {
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * The shared assignability gate every hand-out path runs an Android entry
   * through: idle selection, exact `bindOrReuseDeviceSession`, autolock and the
   * pre-allocation sweeps. It answers one question — may this entry be handed to
   * a session right now — which is presence AND a resolved identity, since the
   * liveness check it performs is also what ENTERS the quarantine.
   */
  async ensurePooledDevicePresentForUse(
    device: PooledDevice,
    options: PooledDevicePresenceOptions = {},
  ): Promise<boolean> {
    const {
      deferRecovery = false,
      assignmentLockHeld = false,
      idleEviction = false,
      discovery,
    } = options;
    const present = await this.state.missingDeviceLiveness.ensurePooledDevicePresent(
      device,
      deferRecovery,
      assignmentLockHeld,
      idleEviction,
      discovery,
    );
    return present && this.state.runtimeIdentity.isPooledDeviceIdentityAssignable(device);
  }

  /** A resolved serial reuse hands the old AVD back to its owner without touching the stranger. */
  restartReleaseReasonForIdentityReplacement(
    device: PooledDevice,
    observation?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ): SessionReleaseReason | undefined {
    const session = holderOf(device) && this.state.sessionManager.getSession(holderOf(device)!);
    if (session && this.state.intentionallyCancelledRecoverySessions.has(session)) {
      return undefined;
    }
    if (
      !observation ||
      !this.callbacks.hasReusableSerial(device) ||
      observation.platform !== "android" ||
      this.state.runtimeIdentity.hasUnresolvedEmulatorName(observation) ||
      this.callbacks.matchesRuntimeIdentity(device, observation)
    ) {
      return undefined;
    }
    const stableDeviceId =
      this.callbacks.stableDeviceIdFor(device) ?? device.preQuarantineStableDeviceId;
    return stableDeviceId !== undefined && stableDeviceId !== observation.name
      ? deviceRestartReleaseReason(stableDeviceId)
      : undefined;
  }

  /**
   * A holder whose assignment moved elsewhere only pins the lost device for deferred rebind
   * cleanup (cf. isCapturedDisconnectTargetCurrent): drop that hold, leaving the session on its
   * new device. Returns whether the hold was dropped.
   */
  dropRebindCleanupHold(device: PooledDevice, sessionId: string): boolean {
    const held = this.state.sessionManager.findSession(sessionId);
    if (!held || held.assignedDevice === device.id) {
      return false;
    }
    this.state.deferredDeviceReleases.delete(device.id);
    unbindDevice(device, { expectedSessionId: sessionId, status: "keep" });
    this.callbacks.notifyDeviceStateChanged(device);
    return true;
  }

  async releaseSessionForEvictedDevice(
    device: PooledDevice,
    incidentId: string | undefined,
    identityObservation?: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ): Promise<boolean> {
    const sessionId = holderOf(device);
    if (!sessionId) {
      return true;
    }
    const isSupersededByNewerIdentity = () => {
      const currentEvidence = deriveEvidenceFromPooledDevice(device);
      return (
        identityObservation !== undefined &&
        !currentEvidence.unresolved &&
        compareIdentityEvidence(
          currentEvidence,
          this.state.runtimeIdentity.identityEvidenceForBootedDevice(identityObservation),
        ) === "stale"
      );
    };
    if (isSupersededByNewerIdentity()) {
      logger.info(
        `[DevicePool] Aborting session release for ${device.id}: a newer identity observation ` +
          "superseded this eviction",
      );
      return false;
    }
    if (this.dropRebindCleanupHold(device, sessionId)) {
      return true;
    }
    const releaseReason =
      this.restartReleaseReasonForIdentityReplacement(device, identityObservation) ??
      deviceLossCancellationReason(device.id, incidentId);
    const attempt = () =>
      this.state.releaseSessionForDisconnectedDevice(
        sessionId,
        device.id,
        releaseReason,
        () => !isSupersededByNewerIdentity(),
        isDeviceRestartReleaseReason(releaseReason) ? { deviceIdentityReplaced: true } : undefined,
      );
    let released: boolean | void = undefined;
    if (isDeviceRestartReleaseReason(releaseReason)) {
      // Quarantine normally drains the holder, but shutdown reservations defer it.
      // Fresh settlement must drain that deferred work before publishing B too.
      if (
        !device.identityUnresolved ||
        this.state.runtimeIdentity.hasDeferredQuarantineCancellation(device)
      ) {
        await this.state.cancelDeviceSessionExecutions(
          sessionId,
          deviceLossCancellationReason(device.id, incidentId),
          { excludeExecutionId: this.state.ambientExecutionIdReader?.getExecutionId() },
        );
      }
      if (isSupersededByNewerIdentity()) {
        return false;
      }
      // Use the existing handoff bookkeeping, including rollback when the fenced
      // release is superseded. Recovery must never stop or boot this reused serial.
      released = await this.releaseSerialReuseRecoverySession(
        device,
        sessionId,
        releaseReason,
        attempt,
      );
    } else {
      released = await this.callbacks.retrySessionRelease(sessionId, device.id, attempt);
    }
    if (released === false) {
      logger.info(
        `[DevicePool] Aborting session release for ${device.id}: a newer identity observation ` +
          "superseded this eviction",
      );
      return false;
    }
    if (!this.callbacks.isPooledEntryCurrent(device)) {
      await this.callbacks.finishEmulatorLossIncident(incidentId, "not-attempted");
      return false;
    }
    this.discardReleasedCapture(sessionId, device.id);
    unbindDevice(device, { status: "keep" });
    this.callbacks.notifyDeviceStateChanged(device);
    return true;
  }

  /** Serial reuse is loss of A, with diagnostics but no relaunch of the reused transport. */
  async releaseSerialReuseRecoverySession(
    device: PooledDevice,
    sessionId: string,
    releaseReason: SessionReleaseReason,
    attempt: () => Promise<boolean | void>,
  ): Promise<boolean | void> {
    const incidentId = await this.callbacks.recordEmulatorLossIncident(device.id, "serial-reuse");
    const result: {
      released: boolean | void;
    } = { released: undefined };
    try {
      await this.callbacks.releaseDisconnectedRecoverySessionWithRetry(
        sessionId,
        device.id,
        releaseReason,
        async () => {
          result.released = await attempt();
        },
      );
      if (result.released === false) {
        await this.callbacks.finishEmulatorLossIncident(incidentId, "not-attempted");
      } else {
        await this.callbacks.completeEmulatorLossRecovery(
          incidentId,
          "not-attempted",
          "awaiting-device",
        );
      }
      return result.released;
    } catch (error) {
      logger.warn(`[DevicePool] Serial-reuse session release failed for ${device.id}`, error);
      await this.callbacks.completeEmulatorLossRecovery(incidentId, "exhausted");
      throw error;
    } finally {
      this.callbacks.settleEmulatorLossIncident(incidentId);
    }
  }

  /** Device-loss releases never reach releaseDevice, the only capture consumer (#11123). */
  discardReleasedCapture(sessionId: string, deviceId: string): void {
    if (this.state.releasedDeviceCaptures.get(sessionId)?.deviceId === deviceId) {
      this.state.releasedDeviceCaptures.delete(sessionId);
    }
  }

  async tryPreserveSessionForMissingDevice(
    device: PooledDevice,
    attemptDeviceLossRecovery: boolean,
    incidentId: string | undefined,
  ): Promise<boolean> {
    const sessionId = holderOf(device) ?? this.state.sessionManager.getSessionForDevice(device.id);
    const session = sessionId ? this.state.sessionManager.getSession(sessionId) : null;
    if (
      !attemptDeviceLossRecovery ||
      !sessionId ||
      !session ||
      isSessionReleasing(this.state.sessionManager, sessionId, session) ||
      !this.callbacks.isSessionPreservingBinding(device, session)
    ) {
      return false;
    }
    return (
      (await this.callbacks.recoverSessionBoundDeviceAfterLoss(device.id, incidentId, device)) !==
      "not-attempted"
    );
  }

  shouldValidatePooledDevicePresence(device: PooledDevice): boolean {
    return this.state.missingDeviceLiveness.shouldValidatePooledDevicePresence(device);
  }

  /** Whether this pooled entry uses an Android emulator serial that can be reassigned. */
  hasReusableSerial(device: PooledDevice): boolean {
    return this.state.missingDeviceLiveness.hasReusableSerial(device);
  }

  takeFreshPresenceDiscovery(platform: Platform): Promise<BootedDeviceDiscovery> {
    return this.state.missingDeviceLiveness.takeFreshPresenceDiscovery(platform);
  }

  evictMissingPooledDevice(
    device: PooledDevice,
    reason: string,
    options: MissingDeviceEvictionOptions = {},
  ): Promise<void> {
    return this.state.missingDeviceLiveness.evictMissingPooledDevice(device, reason, options);
  }

  shouldRebootDisconnectedAndroidDevice(
    device: PooledDevice,
    options: AndroidEmulatorRecoveryOptions = {},
  ): device is AndroidEmulatorRecoveryDevice {
    return (
      (options.bypassRecoveryPolicy || this.callbacks.getRecoveryPolicy().onLoss) &&
      this.callbacks.isAndroidEmulatorActiveRelaunchEligible(device) &&
      (options.allowExistingRecoveryReservation ||
        !this.state.recoveryCoordinator.recoveringAndroidImages.has(device.avdName))
    );
  }
}

export function connectPresence(
  part: () => DevicePoolPresence,
  seams: Pick<
    DevicePoolOperations,
    "tryPreserveSessionForMissingDevice" | "hasReusableSerial" | "evictMissingPooledDevice"
  >,
): PresenceOperations {
  return {
    evictUnavailableIdleDevicesMatching: (...args) =>
      part().evictUnavailableIdleDevicesMatching(...args),
    ensurePooledDevicePresentForUse: (...args) => part().ensurePooledDevicePresentForUse(...args),
    restartReleaseReasonForIdentityReplacement: (...args) =>
      part().restartReleaseReasonForIdentityReplacement(...args),
    dropRebindCleanupHold: (...args) => part().dropRebindCleanupHold(...args),
    releaseSessionForEvictedDevice: (...args) => part().releaseSessionForEvictedDevice(...args),
    releaseSerialReuseRecoverySession: (...args) =>
      part().releaseSerialReuseRecoverySession(...args),
    discardReleasedCapture: (...args) => part().discardReleasedCapture(...args),
    tryPreserveSessionForMissingDevice: (...args) =>
      seams.tryPreserveSessionForMissingDevice(...args),
    shouldValidatePooledDevicePresence: (...args) =>
      part().shouldValidatePooledDevicePresence(...args),
    hasReusableSerial: (...args) => seams.hasReusableSerial(...args),
    takeFreshPresenceDiscovery: (...args) => part().takeFreshPresenceDiscovery(...args),
    evictMissingPooledDevice: (...args) => seams.evictMissingPooledDevice(...args),
    shouldRebootDisconnectedAndroidDevice(
      device: PooledDevice,
      options?: AndroidEmulatorRecoveryOptions,
    ): device is AndroidEmulatorRecoveryDevice {
      return part().shouldRebootDisconnectedAndroidDevice(device, options);
    },
  };
}
