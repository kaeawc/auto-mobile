import { unbindDevice, holderOf } from "../deviceBinding";
import { logger } from "../../utils/logger";
import { type Session } from "../sessionManager";
import { ActionableError } from "../../models";
import { isUnresolvedAndroidEmulatorName } from "../../devices/deviceIdentityEvidence";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { type AndroidEmulatorRecoveryOptions } from "../androidRebootCoordinator";
import type { PooledDevice } from "../devicePoolTypes";
import {
  StopAndroidEmulatorRecoveryOptions,
  RebindSameAvdReplacementSessionOptions,
  BindRecoveredAndroidDeviceSessionOptions,
} from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface AndroidRecoveryOperations {
  rebootDisconnectedAndroidDevice(
    device: PooledDevice,
    incidentId?: string,
    options?: AndroidEmulatorRecoveryOptions,
  ): Promise<boolean>;
  rebootDisconnectedAndroidDeviceCoordinated(
    device: PooledDevice,
    incidentId: string | undefined,
    options: AndroidEmulatorRecoveryOptions,
    signal: AbortSignal,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<boolean>;
  stopAndroidEmulatorForRecovery(
    options: StopAndroidEmulatorRecoveryOptions,
  ): Promise<"stopped" | "same-avd" | "declined">;
  rebindSameAvdReplacementSession(
    options: RebindSameAvdReplacementSessionOptions,
  ): Promise<boolean>;
  sameAvdReplacements(device: PooledDevice, avdName: string): PooledDevice[];
  detachSessionForAndroidRecovery(
    device: PooledDevice,
    preservedSessionId: string | undefined,
    preservedSession: Session | undefined,
  ): boolean;
  bindRecoveredAndroidDeviceSession(
    options: BindRecoveredAndroidDeviceSessionOptions,
  ): Promise<void>;
  consumeAdbServerResetRecoveryCancellation(device: PooledDevice): boolean;
  consumeAndroidRecoveryCancellation(
    device: PooledDevice,
    recoveryDeviceIds: ReadonlySet<string>,
  ): boolean;
  consumeIntentionalShutdown(deviceIds: ReadonlySet<string>): boolean;
  stopTrackedEmulatorProcess(
    deviceId: string,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void>;
}
type AndroidRecoveryState = Pick<
  DevicePoolState,
  | "timer"
  | "lifecycleCoordinator"
  | "androidRebootCoordinator"
  | "devices"
  | "adbServerResetTrackedProcesses"
  | "startedDeviceProcesses"
  | "sessionManager"
  | "adbServerResetQuarantine"
  | "intentionallyCancelledRecoverySessions"
  | "intentionalShutdowns"
  | "emulatorProcessLifecycle"
>;
export type AndroidRecoveryCallbacks = Pick<
  DevicePoolOperations,
  | "shouldRebootDisconnectedAndroidDevice"
  | "stopEmulatorProcess"
  | "getCompletedProcessExit"
  | "stopDiscoveredEmulatorByAvdName"
  | "isPreservedSessionCurrent"
  | "bindOrReuseDeviceSession"
  | "getDevicesByPlatform"
  | "isPooledAndroidEmulator"
  | "stableDeviceIdFor"
  | "notifyDeviceStateChanged"
  | "trackStartedDeviceProcess"
>;

/** Android Recovery responsibilities of DevicePool. */
export class DevicePoolAndroidRecovery {
  constructor(
    private readonly state: AndroidRecoveryState,
    private readonly callbacks: AndroidRecoveryCallbacks,
  ) {}
  async rebootDisconnectedAndroidDevice(
    device: PooledDevice,
    incidentId?: string,
    options: AndroidEmulatorRecoveryOptions = {},
  ): Promise<boolean> {
    if (!this.callbacks.shouldRebootDisconnectedAndroidDevice(device, options)) {
      return false;
    }
    const avdName = device.avdName;
    if (!avdName) {
      return false;
    }
    const deadlineMs = this.state.timer.now() + 300000;
    const lifecycleLease = await this.state.lifecycleCoordinator.reserve(
      { kind: "stable", platform: "android", stableId: avdName },
      { operation: "recovery", deadlineMs },
    );
    let retainedLeaseSettlement: Promise<unknown> | undefined;
    const retainLeaseUntil = (settlement: Promise<unknown>): void => {
      retainedLeaseSettlement = retainedLeaseSettlement
        ? Promise.all([retainedLeaseSettlement, settlement])
        : settlement;
    };
    try {
      return await runWithAbortSignal(
        lifecycleLease.signal,
        async () =>
          await this.rebootDisconnectedAndroidDeviceCoordinated(
            device,
            incidentId,
            options,
            lifecycleLease.signal,
            retainLeaseUntil,
          ),
      );
    } finally {
      if (retainedLeaseSettlement) {
        void retainedLeaseSettlement.then(
          () => lifecycleLease.release(),
          () => lifecycleLease.release(),
        );
      } else {
        lifecycleLease.release();
      }
    }
  }

  async rebootDisconnectedAndroidDeviceCoordinated(
    device: PooledDevice,
    incidentId: string | undefined,
    options: AndroidEmulatorRecoveryOptions,
    signal: AbortSignal,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<boolean> {
    return await this.state.androidRebootCoordinator.rebootDisconnectedAndroidDeviceCoordinated(
      device,
      incidentId,
      options,
      signal,
      retainLeaseUntil,
    );
  }

  async stopAndroidEmulatorForRecovery(
    options: StopAndroidEmulatorRecoveryOptions,
  ): Promise<"stopped" | "same-avd" | "declined"> {
    const {
      device,
      avdName,
      retainLeaseUntil,
      allowActiveStop,
      handoffOwner,
      preservedSessionId,
      preservedSession,
    } = options;
    const current = this.state.devices.get(device.id);
    if (this.sameAvdReplacements(device, avdName).length > 0) {
      return "same-avd";
    }
    if (!allowActiveStop) {
      return "declined";
    }
    if (current && current !== device) {
      logger.info(
        `[DevicePool] Preserving replacement ${current.id} while recovering ${avdName} after ADB reset`,
      );
      return "stopped";
    }
    const detachedProcess = this.state.adbServerResetTrackedProcesses.get(device);
    if (detachedProcess) {
      this.state.adbServerResetTrackedProcesses.delete(device);
      await this.callbacks.stopEmulatorProcess(detachedProcess, retainLeaseUntil);
      return "stopped";
    }
    const trackedProcess = this.state.startedDeviceProcesses.get(device.id);
    const hadTrackedProcess = trackedProcess !== undefined;
    const trackedProcessExited =
      trackedProcess && this.callbacks.getCompletedProcessExit(trackedProcess);
    await this.stopTrackedEmulatorProcess(device.id, retainLeaseUntil);
    if (!hadTrackedProcess || trackedProcessExited) {
      return await this.callbacks.stopDiscoveredEmulatorByAvdName({
        disconnectedDevice: device,
        avdName,
        retainLeaseUntil,
        adoptOnly: hadTrackedProcess,
        handoffOwner,
        preservedSessionId,
        preservedSession,
      });
    }
    return "stopped";
  }

  async rebindSameAvdReplacementSession(
    options: RebindSameAvdReplacementSessionOptions,
  ): Promise<boolean> {
    const {
      device,
      avdName,
      preservedSessionId,
      preservedSession,
      preservedAutolockSessionId,
      recoveryImage,
      handoffOwner,
    } = options;
    const replacements = this.sameAvdReplacements(device, avdName);
    if (replacements.length !== 1) {
      return false;
    }
    const replacement = replacements[0];
    if (!preservedSessionId) {
      return true;
    }
    if (
      preservedSession &&
      !this.callbacks.isPreservedSessionCurrent(preservedSession, device.id)
    ) {
      return false;
    }
    try {
      await this.callbacks.bindOrReuseDeviceSession({
        sessionId: preservedSessionId,
        deviceId: replacement.id,
        platform: "android",
        sourceImage: recoveryImage,
        expectedIdentity: {
          deviceId: replacement.id,
          name: replacement.name,
          platform: "android",
        },
        allowSessionRebind: true,
        readinessReservationOwners: new Set([handoffOwner]),
        expectedExistingSessionDeviceId: device.id,
      });
      replacement.autolockSessionId = preservedAutolockSessionId;
      const detachedProcess = this.state.adbServerResetTrackedProcesses.get(device);
      if (detachedProcess) {
        this.state.adbServerResetTrackedProcesses.delete(device);
        this.state.startedDeviceProcesses.set(replacement.id, detachedProcess);
      }
      const rebound =
        this.state.sessionManager.getSession(preservedSessionId)?.assignedDevice === replacement.id;
      if (rebound) {
        this.state.sessionManager.setDeviceReadiness(preservedSessionId, "booted");
      }
      return rebound;
    } catch (error) {
      logger.warn(
        `[DevicePool] Could not rebind session ${preservedSessionId} to same-AVD replacement ${avdName}: ${error}`,
        error,
      );
      return false;
    }
  }

  sameAvdReplacements(device: PooledDevice, avdName: string): PooledDevice[] {
    return this.callbacks.getDevicesByPlatform("android").filter(
      (candidate) =>
        candidate !== device &&
        this.callbacks.isPooledAndroidEmulator(candidate.id) &&
        !candidate.identityUnresolved &&
        !isUnresolvedAndroidEmulatorName({
          deviceId: candidate.id,
          name: candidate.name,
          platform: candidate.platform,
        }) &&
        this.callbacks.stableDeviceIdFor(candidate) === avdName,
    );
  }

  detachSessionForAndroidRecovery(
    device: PooledDevice,
    preservedSessionId: string | undefined,
    preservedSession: Session | undefined,
  ): boolean {
    if (!preservedSessionId) {
      return true;
    }
    if (
      preservedSession
        ? !this.callbacks.isPreservedSessionCurrent(preservedSession, device.id)
        : this.state.sessionManager.getSession(preservedSessionId)?.assignedDevice !== device.id
    ) {
      return false;
    }
    // Keep the session manager's old routing until the ready replacement is
    // proven. removeDevice requires an unassigned pool entry.
    unbindDevice(device);
    this.callbacks.notifyDeviceStateChanged(device);
    return true;
  }

  async bindRecoveredAndroidDeviceSession(
    options: BindRecoveredAndroidDeviceSessionOptions,
  ): Promise<void> {
    const {
      previousDeviceId,
      avdName,
      preservedSessionId,
      preservedSession,
      ready,
      recoveryImage,
      childProcess,
      preservedAutolockSessionId,
      handoffOwner,
    } = options;
    if (!preservedSessionId) {
      await this.callbacks.trackStartedDeviceProcess(ready, childProcess);
      return;
    }
    if (
      preservedSession
        ? !this.callbacks.isPreservedSessionCurrent(preservedSession, previousDeviceId)
        : this.state.sessionManager.getSession(preservedSessionId)?.assignedDevice !==
          previousDeviceId
    ) {
      throw new ActionableError(
        `Session '${preservedSessionId}' changed while Android AVD '${avdName}' was recovering.`,
      );
    }
    await this.callbacks.bindOrReuseDeviceSession({
      sessionId: preservedSessionId,
      deviceId: ready.deviceId,
      platform: "android",
      sourceImage: recoveryImage,
      childProcess,
      expectedIdentity: ready,
      allowSessionRebind: true,
      readinessReservationOwners: handoffOwner ? new Set([handoffOwner]) : undefined,
      expectedExistingSessionDeviceId: previousDeviceId,
    });
    this.state.sessionManager.setDeviceReadiness(preservedSessionId, "booted");
    const replacement = this.state.devices.get(ready.deviceId);
    if (holderOf(replacement) === preservedSessionId) {
      replacement!.autolockSessionId = preservedAutolockSessionId;
    }
  }

  consumeAdbServerResetRecoveryCancellation(device: PooledDevice): boolean {
    return this.state.adbServerResetQuarantine.consumeAdbServerResetRecoveryCancellation(device);
  }

  consumeAndroidRecoveryCancellation(
    device: PooledDevice,
    recoveryDeviceIds: ReadonlySet<string>,
  ): boolean {
    const cancelled =
      this.consumeAdbServerResetRecoveryCancellation(device) ||
      this.consumeIntentionalShutdown(recoveryDeviceIds);
    if (cancelled) {
      const sessionId = this.state.sessionManager.getSessionForDevice(device.id);
      const session = sessionId && this.state.sessionManager.getSession(sessionId);
      if (session) {
        // Keep the holder's stop decision after its incarnation-scoped marker is consumed.
        this.state.intentionallyCancelledRecoverySessions.add(session);
      }
    }
    return cancelled;
  }

  consumeIntentionalShutdown(deviceIds: ReadonlySet<string>): boolean {
    // Recovery cancellation is deliberately serial-scoped: a user's kill of a
    // serial cancels a pool reboot of that same serial regardless of incarnation
    // (issue #4915). Incarnation gating applies only to the disconnect path in
    // removeDisconnectedDevice.
    let consumed = false;
    for (const deviceId of deviceIds) {
      consumed = this.state.intentionalShutdowns.delete(deviceId) || consumed;
    }
    return consumed;
  }

  async stopTrackedEmulatorProcess(
    deviceId: string,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    return this.state.emulatorProcessLifecycle.stopTrackedEmulatorProcess(
      deviceId,
      retainLeaseUntil,
    );
  }
}

export function connectAndroidRecovery(
  part: () => DevicePoolAndroidRecovery,
  seams: Pick<DevicePoolOperations, never>,
): AndroidRecoveryOperations {
  return {
    rebootDisconnectedAndroidDevice: (...args) => part().rebootDisconnectedAndroidDevice(...args),
    rebootDisconnectedAndroidDeviceCoordinated: (...args) =>
      part().rebootDisconnectedAndroidDeviceCoordinated(...args),
    stopAndroidEmulatorForRecovery: (...args) => part().stopAndroidEmulatorForRecovery(...args),
    rebindSameAvdReplacementSession: (...args) => part().rebindSameAvdReplacementSession(...args),
    sameAvdReplacements: (...args) => part().sameAvdReplacements(...args),
    detachSessionForAndroidRecovery: (...args) => part().detachSessionForAndroidRecovery(...args),
    bindRecoveredAndroidDeviceSession: (...args) =>
      part().bindRecoveredAndroidDeviceSession(...args),
    consumeAdbServerResetRecoveryCancellation: (...args) =>
      part().consumeAdbServerResetRecoveryCancellation(...args),
    consumeAndroidRecoveryCancellation: (...args) =>
      part().consumeAndroidRecoveryCancellation(...args),
    consumeIntentionalShutdown: (...args) => part().consumeIntentionalShutdown(...args),
    stopTrackedEmulatorProcess: (...args) => part().stopTrackedEmulatorProcess(...args),
  };
}
