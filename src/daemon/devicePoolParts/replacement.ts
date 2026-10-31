import { holderOf } from "../deviceBinding";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import { type Session } from "../sessionManager";
import { BootedDevice, DeviceInfo } from "../../models";
import { deviceLossCancellationReason } from "../emulatorLossIncident";
import { type DeviceRetirementOptions } from "../deviceRuntimeIdentity";
import type { PooledDevice } from "../devicePoolTypes";
import {
  DiscoveryReconcileOptions,
  SystemUiAnrRecoveryHandoff,
  type SystemUiAnrReplacementOptions,
} from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface ReplacementOperations {
  retireDeviceForShutdown(
    expectedDevice: PooledDevice,
    options?: DeviceRetirementOptions,
  ): Promise<boolean>;
  retireDeviceAfterSystemUiAnrRecoveryFailure(expectedDevice: PooledDevice): Promise<boolean>;
  replaceDeviceForShutdown(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    beforeReplacementPublishes?: () => void,
    options?: Pick<DiscoveryReconcileOptions, "excludeExecutionId">,
  ): Promise<PooledDevice | undefined>;
  replaceDeviceForSystemUiAnrRecovery(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
    options?: SystemUiAnrReplacementOptions & { childProcess?: ChildProcess | null },
  ): Promise<SystemUiAnrRecoveryHandoff>;
  settleSystemUiAnrOriginalClaim(originalDeviceId: string): void;
  validateSystemUiAnrRecoverySession(
    preservedSession: Session | undefined,
    replacementDevice: PooledDevice,
  ): Promise<void>;
  rollbackSystemUiAnrRecoveryReplacement(
    replacementDevice: PooledDevice | undefined,
    preservedSession: Session | undefined,
  ): Promise<void>;
  assertSystemUiAnrReplacement(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
  ): void;
  systemUiAnrRecoverySession(expectedDevice: PooledDevice): Session | undefined;
  replaceStoppedDeviceForSystemUiAnr(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
    options?: { beforeReplacementPublishes?: () => void; excludeExecutionId?: string },
  ): Promise<PooledDevice>;
  cancelOldDeviceWorkForSystemUiAnr(deviceId: string, excludeExecutionId?: string): Promise<void>;
  assertPooledSystemUiAnrReplacement(replacement: PooledDevice, sourceImage: DeviceInfo): void;
  adoptSystemUiAnrReplacement(
    replacementDevice: PooledDevice,
    sourceImage: DeviceInfo,
    priorAssignmentCount: number,
    priorLastUsedAt: number,
  ): Promise<PooledDevice>;
  restoreSystemUiAnrRecoverySession(
    session: Session | undefined,
    originalDeviceId: string,
    replacementDevice: PooledDevice,
    autolockSessionId: string | undefined,
  ): Promise<void>;
  claimSystemUiAnrReplacement(replacementDevice: PooledDevice): Promise<void>;
  sourceImageForSameAndroidReplacement(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
  ): DeviceInfo | undefined;
  releaseCapturedDeviceForShutdown(device: PooledDevice): void;
}
type ReplacementState = Pick<
  DevicePoolState,
  "assignmentMutex" | "runtimeIdentity" | "devices" | "intentionalShutdowns" | "deviceReplacement"
>;
export type ReplacementCallbacks = Pick<
  DevicePoolOperations,
  | "isPooledEntryCurrent"
  | "removeDevice"
  | "releaseDisconnectedRecoverySessionWithRetry"
  | "retireDeviceForShutdown"
>;

/** Replacement responsibilities of DevicePool. */
export class DevicePoolReplacement {
  constructor(
    private readonly state: ReplacementState,
    private readonly callbacks: ReplacementCallbacks,
  ) {}
  /**
   * Retire a captured device incarnation without publishing it as idle first.
   * A device that has been explicitly stopped must not become assignable in the
   * interval between its session release and pool removal.
   */
  async retireDeviceForShutdown(
    expectedDevice: PooledDevice,
    options: DeviceRetirementOptions = {},
  ): Promise<boolean> {
    return await this.state.assignmentMutex.runExclusive(async () => {
      if (!this.callbacks.isPooledEntryCurrent(expectedDevice)) {
        return false;
      }
      await this.state.runtimeIdentity.cancelRetiredDeviceExecutions(expectedDevice, options);
      if (!this.callbacks.isPooledEntryCurrent(expectedDevice)) {
        return false;
      }
      this.releaseCapturedDeviceForShutdown(expectedDevice);
      await this.callbacks.removeDevice(expectedDevice.id, false, expectedDevice);
      const retired = !this.state.devices.has(expectedDevice.id);
      if (retired) {
        this.state.intentionalShutdowns.delete(expectedDevice.id);
      }
      return retired;
    });
  }

  /**
   * A System UI recovery that has confirmed shutdown but cannot restore the
   * AVD has no usable successor for the session. Release it before retiring
   * the captured connection epoch.
   */
  async retireDeviceAfterSystemUiAnrRecoveryFailure(
    expectedDevice: PooledDevice,
  ): Promise<boolean> {
    let releaseError: unknown;
    if (holderOf(expectedDevice)) {
      try {
        await this.callbacks.releaseDisconnectedRecoverySessionWithRetry(
          holderOf(expectedDevice)!,
          expectedDevice.id,
          deviceLossCancellationReason(expectedDevice.id),
        );
      } catch (error) {
        releaseError = error;
      }
    }
    const retired = await this.callbacks.retireDeviceForShutdown(expectedDevice, {
      cancelDeviceBoundExecutions: false,
    });
    if (releaseError) {
      throw releaseError;
    }
    return retired;
  }

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
    return this.state.deviceReplacement.replaceDeviceForShutdown(
      expectedDevice,
      replacement,
      beforeReplacementPublishes,
      options,
    );
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
    {
      childProcess,
      ...options
    }: SystemUiAnrReplacementOptions & { childProcess?: ChildProcess | null } = {},
  ): Promise<SystemUiAnrRecoveryHandoff> {
    return this.state.deviceReplacement.replaceDeviceForSystemUiAnrRecovery(
      expectedDevice,
      replacement,
      sourceImage,
      { childProcess, ...options },
    );
  }

  /**
   * The original incarnation was removed with its claim kept, so the claim file is never absent
   * between the old and the new pool entry (#11448). Withdraw it here unless a session of this
   * daemon holds a device under that serial: a same-serial replacement keeps the claim, while a
   * different-serial replacement (whose own claim is published by now) and a failed recovery
   * give it up.
   */
  settleSystemUiAnrOriginalClaim(originalDeviceId: string): void {
    return this.state.deviceReplacement.settleSystemUiAnrOriginalClaim(originalDeviceId);
  }

  async validateSystemUiAnrRecoverySession(
    preservedSession: Session | undefined,
    replacementDevice: PooledDevice,
  ): Promise<void> {
    return this.state.deviceReplacement.validateSystemUiAnrRecoverySession(
      preservedSession,
      replacementDevice,
    );
  }

  async rollbackSystemUiAnrRecoveryReplacement(
    replacementDevice: PooledDevice | undefined,
    preservedSession: Session | undefined,
  ): Promise<void> {
    return this.state.deviceReplacement.rollbackSystemUiAnrRecoveryReplacement(
      replacementDevice,
      preservedSession,
    );
  }

  assertSystemUiAnrReplacement(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
  ): void {
    return this.state.deviceReplacement.assertSystemUiAnrReplacement(
      expectedDevice,
      replacement,
      sourceImage,
    );
  }

  systemUiAnrRecoverySession(expectedDevice: PooledDevice): Session | undefined {
    return this.state.deviceReplacement.systemUiAnrRecoverySession(expectedDevice);
  }

  async replaceStoppedDeviceForSystemUiAnr(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
    sourceImage: DeviceInfo,
    {
      beforeReplacementPublishes,
      excludeExecutionId,
    }: { beforeReplacementPublishes?: () => void; excludeExecutionId?: string } = {},
  ): Promise<PooledDevice> {
    return this.state.deviceReplacement.replaceStoppedDeviceForSystemUiAnr(
      expectedDevice,
      replacement,
      sourceImage,
      { beforeReplacementPublishes, excludeExecutionId },
    );
  }

  async cancelOldDeviceWorkForSystemUiAnr(
    deviceId: string,
    excludeExecutionId?: string,
  ): Promise<void> {
    return this.state.deviceReplacement.cancelOldDeviceWorkForSystemUiAnr(
      deviceId,
      excludeExecutionId,
    );
  }

  assertPooledSystemUiAnrReplacement(replacement: PooledDevice, sourceImage: DeviceInfo): void {
    return this.state.deviceReplacement.assertPooledSystemUiAnrReplacement(
      replacement,
      sourceImage,
    );
  }

  async adoptSystemUiAnrReplacement(
    replacementDevice: PooledDevice,
    sourceImage: DeviceInfo,
    priorAssignmentCount: number,
    priorLastUsedAt: number,
  ): Promise<PooledDevice> {
    return this.state.deviceReplacement.adoptSystemUiAnrReplacement(
      replacementDevice,
      sourceImage,
      priorAssignmentCount,
      priorLastUsedAt,
    );
  }

  async restoreSystemUiAnrRecoverySession(
    session: Session | undefined,
    originalDeviceId: string,
    replacementDevice: PooledDevice,
    autolockSessionId: string | undefined,
  ): Promise<void> {
    return this.state.deviceReplacement.restoreSystemUiAnrRecoverySession(
      session,
      originalDeviceId,
      replacementDevice,
      autolockSessionId,
    );
  }

  /**
   * Publish this daemon's claim on the System UI recovery replacement the session is about to be
   * bound to. The caller's rollback removes the replacement (withdrawing the claim) on any later
   * failure. Throws the typed refusal when another live daemon holds the replacement.
   */
  async claimSystemUiAnrReplacement(replacementDevice: PooledDevice): Promise<void> {
    return this.state.deviceReplacement.claimSystemUiAnrReplacement(replacementDevice);
  }

  sourceImageForSameAndroidReplacement(
    expectedDevice: PooledDevice,
    replacement: BootedDevice,
  ): DeviceInfo | undefined {
    return this.state.deviceReplacement.sourceImageForSameAndroidReplacement(
      expectedDevice,
      replacement,
    );
  }

  releaseCapturedDeviceForShutdown(device: PooledDevice): void {
    return this.state.deviceReplacement.releaseCapturedDeviceForShutdown(device);
  }
}

export function connectReplacement(
  part: () => DevicePoolReplacement,
  seams: Pick<
    DevicePoolOperations,
    | "retireDeviceForShutdown"
    | "retireDeviceAfterSystemUiAnrRecoveryFailure"
    | "replaceDeviceForShutdown"
    | "replaceDeviceForSystemUiAnrRecovery"
    | "cancelOldDeviceWorkForSystemUiAnr"
  >,
): ReplacementOperations {
  return {
    retireDeviceForShutdown: (...args) => seams.retireDeviceForShutdown(...args),
    retireDeviceAfterSystemUiAnrRecoveryFailure: (...args) =>
      seams.retireDeviceAfterSystemUiAnrRecoveryFailure(...args),
    replaceDeviceForShutdown: (...args) => seams.replaceDeviceForShutdown(...args),
    replaceDeviceForSystemUiAnrRecovery: (...args) =>
      seams.replaceDeviceForSystemUiAnrRecovery(...args),
    settleSystemUiAnrOriginalClaim: (...args) => part().settleSystemUiAnrOriginalClaim(...args),
    validateSystemUiAnrRecoverySession: (...args) =>
      part().validateSystemUiAnrRecoverySession(...args),
    rollbackSystemUiAnrRecoveryReplacement: (...args) =>
      part().rollbackSystemUiAnrRecoveryReplacement(...args),
    assertSystemUiAnrReplacement: (...args) => part().assertSystemUiAnrReplacement(...args),
    systemUiAnrRecoverySession: (...args) => part().systemUiAnrRecoverySession(...args),
    replaceStoppedDeviceForSystemUiAnr: (...args) =>
      part().replaceStoppedDeviceForSystemUiAnr(...args),
    cancelOldDeviceWorkForSystemUiAnr: (...args) =>
      seams.cancelOldDeviceWorkForSystemUiAnr(...args),
    assertPooledSystemUiAnrReplacement: (...args) =>
      part().assertPooledSystemUiAnrReplacement(...args),
    adoptSystemUiAnrReplacement: (...args) => part().adoptSystemUiAnrReplacement(...args),
    restoreSystemUiAnrRecoverySession: (...args) =>
      part().restoreSystemUiAnrRecoverySession(...args),
    claimSystemUiAnrReplacement: (...args) => part().claimSystemUiAnrReplacement(...args),
    sourceImageForSameAndroidReplacement: (...args) =>
      part().sourceImageForSameAndroidReplacement(...args),
    releaseCapturedDeviceForShutdown: (...args) => part().releaseCapturedDeviceForShutdown(...args),
  };
}
