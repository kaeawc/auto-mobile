import { bindDevice, unbindDevice, holderOf, isBusy, isIdle } from "./deviceBinding";
import type { Mutex } from "async-mutex";
import { ActionableError, type BootedDevice, type DeviceInfo, type Platform } from "../models";
import { logger } from "../utils/logger";
import type { DeviceCriteriaMatcher } from "./DeviceCriteriaMatcher";
import type { ConnectionOwnership } from "./connectionOwnership";
import { DeviceOwnedByOtherDaemonError } from "../models/deviceAcquisitionRefusals";
import type {
  DevicePool,
  DeviceAutolockChildProcess as ChildProcess,
  DeviceSessionExecutionCanceller,
  DiscoveryReconcileOptions,
  PooledDevice,
  SystemUiAnrRecoveryHandoff,
  SystemUiAnrReplacementOptions,
} from "./devicePool";
import type { DeviceRuntimeIdentity } from "./deviceRuntimeIdentity";
import { deviceLossCancellationReason } from "./emulatorLossIncident";
import type { ForeignDeviceOwnership } from "./foreignDeviceOwnership";
import type { Session, SessionManager } from "./sessionManager";

export interface DeviceReplacementPort extends Pick<DevicePool, "removeDevice" | "addDevice"> {
  readonly assignmentMutex: Pick<Mutex, "runExclusive">;
  isPooledEntryCurrent(device: PooledDevice): boolean;
  readonly runtimeIdentity: Pick<
    DeviceRuntimeIdentity,
    "cancelRetiredDeviceExecutions" | "identityEvidenceForBootedDevice"
  >;
  releaseCapturedDeviceForShutdown(device: PooledDevice): void;
  readonly devices: Pick<ReadonlyMap<string, PooledDevice>, "get" | "has">;
  readonly intentionalShutdowns: Pick<Map<string, number>, "delete">;
  sourceImageForSameAndroidReplacement(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
  ): DeviceInfo | undefined;
  assertSystemUiAnrReplacement(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
  ): void;
  systemUiAnrRecoverySession(expectedDevice: PooledDevice): Session | undefined;
  trackStartedDeviceProcess(
    device: BootedDevice,
    childProcess: ChildProcess | null | undefined,
  ): Promise<void>;
  cancelOldDeviceWorkForSystemUiAnr(deviceId: string, excludeExecutionId?: string): Promise<void>;
  recordSourceAndroidAvd(deviceId: string, sourceImage?: DeviceInfo): void;
  readonly pooledSessionIdentities: Pick<WeakMap<PooledDevice, Session>, "set">;
  nextLastUsedAt(): number;
  rollbackSystemUiAnrRecoveryReplacement(
    replacementDevice: PooledDevice | undefined,
    preservedSession: Session | undefined,
  ): Promise<void>;
  settleSystemUiAnrOriginalClaim(originalDeviceId: string): void;
  transferMcpSessionRecoveryLeases(previous: PooledDevice, replacement: PooledDevice): void;
  validateSystemUiAnrRecoverySession(
    preservedSession: Session | undefined,
    replacementDevice: PooledDevice,
  ): Promise<void>;
  releaseDeviceClaim(deviceId: string): void;
  readonly sessionManager: Pick<
    SessionManager,
    "getSession" | "releaseSession" | "rebindSessionForTerminalReleaseRecovery"
  >;
  retrySessionRelease<T>(
    sessionId: string,
    deviceId: string,
    attempt: () => Promise<T>,
  ): Promise<T>;
  readonly cancelDeviceSessionExecutions: Pick<
    DeviceSessionExecutionCanceller,
    "cancelDeviceExecutions"
  >;
  foreignOwnershipFor(platform: Platform | undefined): ForeignDeviceOwnership | undefined;
  readonly connectionOwnership: Pick<ConnectionOwnership, "recordClaim">;
  readonly criteriaMatcher: Pick<DeviceCriteriaMatcher, "androidRediscoveryMatches">;
  lastReleasedDeviceId: string | null;
  notifyDeviceStateChanged(device: Pick<PooledDevice, "id" | "platform">): void;
}

export class DeviceReplacement {
  constructor(private readonly port: DeviceReplacementPort) {}

  /**
   * Atomically replace a captured stopped-device incarnation with the device
   * discovered under the same ID. This keeps allocators from claiming the old
   * device during the handoff.
   */
  async replaceDeviceForShutdown(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    beforeReplacementPublishes?: () => void,
    options: Pick<DiscoveryReconcileOptions, "excludeExecutionId"> = {},
  ): Promise<PooledDevice | undefined> {
    return await this.port.assignmentMutex.runExclusive(async () => {
      if (!this.port.isPooledEntryCurrent(expectedDevice)) {
        return undefined;
      }
      // A kill's same-serial successor must not inherit the old device's work.
      // System UI recovery uses its separate session-preserving handoff.
      await this.port.runtimeIdentity.cancelRetiredDeviceExecutions(expectedDevice, options);
      if (!this.port.isPooledEntryCurrent(expectedDevice)) {
        return undefined;
      }
      this.port.releaseCapturedDeviceForShutdown(expectedDevice);
      await this.port.removeDevice(expectedDevice.id, false, expectedDevice);
      if (this.port.devices.has(expectedDevice.id)) {
        return undefined;
      }
      this.port.intentionalShutdowns.delete(expectedDevice.id);
      beforeReplacementPublishes?.();
      await this.port.addDevice(
        replacement,
        this.port.sourceImageForSameAndroidReplacement(expectedDevice, replacement),
        false,
        this.port.runtimeIdentity.identityEvidenceForBootedDevice(replacement),
      );
      return this.port.devices.get(replacement.deviceId);
    });
  }

  /**
   * Replace a stopped Android runtime while retaining the active AutoMobile
   * session. The caller keeps both a shutdown reservation and a stable AVD
   * readiness reservation until this handoff has completed.
   */
  async replaceDeviceForSystemUiAnrRecovery(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
    childProcess?: ChildProcess | null,
    { beforeReplacementPublishes, excludeExecutionId }: SystemUiAnrReplacementOptions = {},
  ): Promise<SystemUiAnrRecoveryHandoff> {
    return await this.port.assignmentMutex.runExclusive(async () => {
      // The caller's marker must cover the entire visible replacement
      // lifecycle, including a replacement that another pool path has already
      // discovered. It is moved before any session rebind or addDevice call.
      beforeReplacementPublishes?.();
      const currentExpectedDevice = this.port.devices.get(expectedDevice.id);
      const existingReplacement = this.port.devices.get(replacement.deviceId);
      if (
        currentExpectedDevice !== expectedDevice &&
        (existingReplacement === undefined || existingReplacement === expectedDevice)
      ) {
        throw new ActionableError(
          `Device '${expectedDevice.id}' changed while System UI recovery was in progress.`,
        );
      }
      this.port.assertSystemUiAnrReplacement(expectedDevice, replacement, sourceImage);

      const preservedSession = this.port.systemUiAnrRecoverySession(expectedDevice);
      const preservedSessionId = preservedSession?.sessionId;
      const preservedAutolockSessionId = expectedDevice.autolockSessionId;
      let replacementDevice: PooledDevice | undefined;
      try {
        replacementDevice = await this.replaceStoppedDeviceForSystemUiAnr(
          expectedDevice,
          replacement,
          sourceImage,
          beforeReplacementPublishes,
          excludeExecutionId,
        );
        await this.port.trackStartedDeviceProcess(replacement, childProcess);
        if (!this.port.isPooledEntryCurrent(replacementDevice)) {
          throw new ActionableError(
            `Replacement device '${replacementDevice.id}' exited before its recovery session was rebound.`,
          );
        }
        await this.restoreSystemUiAnrRecoverySession(
          preservedSession,
          expectedDevice.id,
          replacementDevice,
          preservedAutolockSessionId,
        );
      } catch (error) {
        // Once the handoff has detached the original incarnation, roll any
        // replacement back and release the preserved session so caller cleanup
        // cannot leave an idle device mapped to the stopped serial.
        const originalWasDetached =
          !this.port.isPooledEntryCurrent(expectedDevice) ||
          (preservedSession !== undefined && holderOf(expectedDevice) === null);
        if (originalWasDetached) {
          await this.port.rollbackSystemUiAnrRecoveryReplacement(
            replacementDevice,
            preservedSession,
          );
        }
        throw error;
      } finally {
        this.port.settleSystemUiAnrOriginalClaim(expectedDevice.id);
      }
      if (!replacementDevice) {
        throw new ActionableError(
          `Replacement device '${replacement.deviceId}' was not retained by the device pool.`,
        );
      }
      this.port.transferMcpSessionRecoveryLeases(expectedDevice, replacementDevice);
      this.port.intentionalShutdowns.delete(expectedDevice.id);
      return {
        preservedSessionId,
        replacementDevice,
        validatePreservedSession: async () => {
          await this.port.validateSystemUiAnrRecoverySession(preservedSession, replacementDevice);
        },
      };
    });
  }

  /**
   * The original incarnation was removed with its claim kept, so the claim file is never absent
   * between the old and the new pool entry (#11448). Withdraw it here unless a session of this
   * daemon holds a device under that serial: a same-serial replacement keeps the claim, while a
   * different-serial replacement (whose own claim is published by now) and a failed recovery
   * give it up.
   */
  settleSystemUiAnrOriginalClaim(originalDeviceId: string): void {
    if (!holderOf(this.port.devices.get(originalDeviceId))) {
      this.port.releaseDeviceClaim(originalDeviceId);
    }
  }

  async validateSystemUiAnrRecoverySession(
    preservedSession: Session | undefined,
    replacementDevice: PooledDevice,
  ): Promise<void> {
    if (!preservedSession) {
      return;
    }
    await this.port.assignmentMutex.runExclusive(() => {
      if (
        !this.port.isPooledEntryCurrent(replacementDevice) ||
        holderOf(replacementDevice) !== preservedSession.sessionId ||
        !isBusy(replacementDevice) ||
        this.port.sessionManager.getSession(preservedSession.sessionId) !== preservedSession ||
        preservedSession.assignedDevice !== replacementDevice.id
      ) {
        throw new ActionableError(
          `Session '${preservedSession.sessionId}' was released while System UI recovery was becoming ready.`,
        );
      }
    });
  }

  async rollbackSystemUiAnrRecoveryReplacement(
    replacementDevice: PooledDevice | undefined,
    preservedSession: Session | undefined,
  ): Promise<void> {
    if (replacementDevice) {
      await this.port.removeDevice(replacementDevice.id, false, replacementDevice);
    }
    if (
      preservedSession &&
      this.port.sessionManager.getSession(preservedSession.sessionId) === preservedSession
    ) {
      await this.port.retrySessionRelease(
        preservedSession.sessionId,
        preservedSession.assignedDevice,
        () =>
          this.port.sessionManager.releaseSession(
            preservedSession.sessionId,
            deviceLossCancellationReason(replacementDevice?.id ?? preservedSession.assignedDevice),
            {
              expectedOwner: {
                session: preservedSession,
                deviceId: preservedSession.assignedDevice,
              },
            },
          ),
      );
    }
  }

  assertSystemUiAnrReplacement(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
  ): void {
    if (
      expectedDevice.platform !== "android" ||
      replacement.platform !== "android" ||
      sourceImage.platform !== "android" ||
      replacement.name !== sourceImage.name
    ) {
      throw new ActionableError(
        `System UI recovery must replace Android AVD '${sourceImage.name}' with the same runtime.`,
      );
    }
  }

  systemUiAnrRecoverySession(expectedDevice: PooledDevice): Session | undefined {
    const sessionId = holderOf(expectedDevice);
    const session = sessionId ? this.port.sessionManager.getSession(sessionId) : null;
    if (
      session === null ||
      session.assignedDevice !== expectedDevice.id ||
      session.platform !== "android"
    ) {
      return undefined;
    }
    return session;
  }

  async cancelOldDeviceWorkForSystemUiAnr(
    deviceId: string,
    excludeExecutionId?: string,
  ): Promise<void> {
    if (excludeExecutionId === undefined) {
      logger.warn(
        `[DevicePool] Left old-device work running for ${deviceId} because the System UI ANR recovery execution is unknown`,
      );
      return;
    }
    await this.port.cancelDeviceSessionExecutions.cancelDeviceExecutions?.(
      deviceId,
      deviceLossCancellationReason(deviceId),
      { excludeExecutionId },
    );
  }

  assertPooledSystemUiAnrReplacement(replacement: PooledDevice, sourceImage: DeviceInfo): void {
    if (
      replacement.platform !== "android" ||
      sourceImage.platform !== "android" ||
      replacement.name !== sourceImage.name
    ) {
      throw new ActionableError(
        `System UI recovery replacement '${replacement.id}' does not match Android AVD '${sourceImage.name}'.`,
      );
    }
    if (!isIdle(replacement) || holderOf(replacement) !== null) {
      throw new ActionableError(
        `System UI recovery replacement '${replacement.id}' is already assigned to a session.`,
      );
    }
  }

  /**
   * Publish this daemon's claim on the System UI recovery replacement the session is about to be
   * bound to. The caller's rollback removes the replacement (withdrawing the claim) on any later
   * failure. Throws the typed refusal when another live daemon holds the replacement.
   */
  async claimSystemUiAnrReplacement(replacementDevice: PooledDevice): Promise<void> {
    const ownership = this.port.foreignOwnershipFor(replacementDevice.platform);
    if (!ownership) {
      return;
    }
    if (await ownership.claim(replacementDevice.id)) {
      this.port.connectionOwnership.recordClaim(replacementDevice.id, ownership);
      return;
    }
    await ownership.refresh([replacementDevice.id]);
    throw new DeviceOwnedByOtherDaemonError(
      replacementDevice.id,
      ownership.foreignOwnerPid(replacementDevice.id),
    );
  }

  sourceImageForSameAndroidReplacement(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
  ): DeviceInfo | undefined {
    if (
      expectedDevice.platform !== "android" ||
      replacement.platform !== "android" ||
      !expectedDevice.avdName ||
      !expectedDevice.androidImage ||
      replacement.name !== expectedDevice.avdName ||
      !this.port.criteriaMatcher.androidRediscoveryMatches(
        replacement,
        expectedDevice.id,
        expectedDevice.avdName,
      )
    ) {
      return undefined;
    }
    return expectedDevice.androidImage;
  }

  releaseCapturedDeviceForShutdown(device: PooledDevice): void {
    unbindDevice(device);
    device.errorCount = 0;
    this.port.lastReleasedDeviceId = device.id;
    this.port.notifyDeviceStateChanged(device);
  }

  async replaceStoppedDeviceForSystemUiAnr(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
    beforeReplacementPublishes?: () => void,
    excludeExecutionId?: string,
  ): Promise<PooledDevice> {
    const priorAssignmentCount = expectedDevice.assignmentCount;
    const priorLastUsedAt = expectedDevice.lastUsedAt;
    const existingReplacement = this.port.devices.get(replacement.deviceId);

    if (existingReplacement && existingReplacement !== expectedDevice) {
      this.assertPooledSystemUiAnrReplacement(existingReplacement, sourceImage);
      if (this.port.isPooledEntryCurrent(expectedDevice)) {
        await this.port.cancelOldDeviceWorkForSystemUiAnr(expectedDevice.id, excludeExecutionId);
        this.port.releaseCapturedDeviceForShutdown(expectedDevice);
        await this.port.removeDevice(expectedDevice.id, false, expectedDevice, {
          keepDeviceClaim: true,
        });
      }
      return await this.adoptSystemUiAnrReplacement(
        existingReplacement,
        sourceImage,
        priorAssignmentCount,
        priorLastUsedAt,
      );
    }

    // removeDevice rejects busy entries, so detach pool ownership only after
    // capturing any session that must be rebound below. The replacement remains
    // unavailable through the caller's readiness reservation while this runs. The session's
    // claim stays published across the removal; the caller settles it when the handoff ends.
    await this.port.cancelOldDeviceWorkForSystemUiAnr(expectedDevice.id, excludeExecutionId);
    this.port.releaseCapturedDeviceForShutdown(expectedDevice);
    await this.port.removeDevice(expectedDevice.id, false, expectedDevice, {
      keepDeviceClaim: true,
    });
    if (this.port.devices.has(replacement.deviceId)) {
      throw new ActionableError(
        `Replacement device '${replacement.deviceId}' was already added to the device pool.`,
      );
    }

    await this.port.addDevice(
      replacement,
      sourceImage,
      false,
      this.port.runtimeIdentity.identityEvidenceForBootedDevice(replacement),
    );
    const replacementDevice = this.port.devices.get(replacement.deviceId);
    if (!replacementDevice) {
      throw new ActionableError(
        `Replacement device '${replacement.deviceId}' was not retained by the device pool.`,
      );
    }
    replacementDevice.assignmentCount = priorAssignmentCount;
    replacementDevice.lastUsedAt = priorLastUsedAt;
    return replacementDevice;
  }

  async adoptSystemUiAnrReplacement(
    replacementDevice: PooledDevice,
    sourceImage: DeviceInfo,
    priorAssignmentCount: number,
    priorLastUsedAt: number,
  ): Promise<PooledDevice> {
    this.port.recordSourceAndroidAvd(replacementDevice.id, sourceImage);
    replacementDevice.assignmentCount = priorAssignmentCount;
    replacementDevice.lastUsedAt = priorLastUsedAt;
    return replacementDevice;
  }

  async restoreSystemUiAnrRecoverySession(
    session: Session | undefined,
    originalDeviceId: string,
    replacementDevice: PooledDevice,
    autolockSessionId: string | undefined,
  ): Promise<void> {
    if (!session) {
      return;
    }
    if (
      this.port.sessionManager.getSession(session.sessionId) !== session ||
      session.assignedDevice !== originalDeviceId
    ) {
      throw new ActionableError(
        `Session '${session.sessionId}' was released while System UI recovery was in progress.`,
      );
    }
    // Publish the claim before the session is bound to the replacement, so another daemon never
    // sees a device this session drives as free. A refusal here fails the recovery through the
    // caller's rollback, which removes the replacement and releases the session.
    await this.claimSystemUiAnrReplacement(replacementDevice);
    const reboundSession = await this.port.sessionManager.rebindSessionForTerminalReleaseRecovery(
      session,
      replacementDevice.id,
      replacementDevice.platform,
    );
    if (
      !this.port.isPooledEntryCurrent(replacementDevice) ||
      reboundSession !== session ||
      reboundSession.assignedDevice !== replacementDevice.id
    ) {
      throw new ActionableError(
        `Replacement device '${replacementDevice.id}' disconnected while its recovery session was being rebound.`,
      );
    }
    bindDevice(replacementDevice, session.sessionId);
    this.port.pooledSessionIdentities.set(replacementDevice, session);
    // addDevice leaves autolockSessionId undefined, which assertAutolockAccess
    // reads as "unlocked" and would let any session drive the recovered device
    // while the mcpSessionAutolockMap still points at the original. Carry the
    // lock forward so the original session keeps exclusive access.
    replacementDevice.autolockSessionId = autolockSessionId;
    replacementDevice.lastUsedAt = this.port.nextLastUsedAt();
    this.port.notifyDeviceStateChanged(replacementDevice);
  }
}
