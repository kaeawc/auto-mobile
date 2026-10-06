import { ActionableError, type BootedDevice, type DeviceInfo } from "../models";
import type { ChildProcess, PlatformDeviceManager } from "../devices/deviceUtils";
import { waitForDeviceReadyOrCancel } from "../devices/deviceUtils";
import type { Timer } from "../utils/SystemTimer";
import type { AndroidDeviceReboot } from "../devices/androidDeviceReboot";
import { logger } from "../utils/logger";
import type { DeviceCriteriaMatcher } from "./DeviceCriteriaMatcher";
import type { IdentityEvidence } from "../devices/deviceIdentityEvidence";
import type { PooledDevice, DeviceRecoveryPolicy } from "./devicePool";
import type { Session } from "./sessionManager";
import type { AndroidRecoveryRecordLedger } from "./androidRecoveryRecordLedger";

interface SameAvdRecoveryContext {
  device: PooledDevice;
  avdName: string;
  preservedSessionId: string | undefined;
  preservedSession: Session | undefined;
  preservedAutolockSessionId: string | undefined;
  recoveryImage: DeviceInfo;
  incidentId: string | undefined;
  handoffOwner: symbol;
}

function trackLateShutdowns(retainLeaseUntil: (settlement: Promise<unknown>) => void) {
  const settlements: Promise<unknown>[] = [];
  return {
    retainLeaseUntil: (settlement: Promise<unknown>): void => {
      settlements.push(settlement);
      retainLeaseUntil(settlement);
    },
    settledWhen: (retained: boolean): Promise<unknown> | undefined =>
      retained ? Promise.allSettled(settlements) : undefined,
  };
}

export class UnconfirmedRecoveryShutdownError extends ActionableError {
  constructor(avdName: string, cause: unknown) {
    super(
      `Shutdown of Android emulator '${avdName}' is unconfirmed; recovery ownership remains quarantined`,
      { cause },
    );
  }
}

export interface AndroidEmulatorRecoveryOptions {
  preserveSessionId?: string;
  preserveSession?: Session;
  bypassRecoveryPolicy?: boolean;
  /**
   * Independently of bypassRecoveryPolicy's passive-preservation entry gate,
   * controls whether recovery may actively stop and relaunch the AVD process.
   * Defaults to the opt-in recovery policy's onLoss setting when omitted.
   */
  allowActiveRelaunch?: boolean;
  allowExistingRecoveryReservation?: boolean;
}

export interface AndroidRebootCoordinatorPoolPort {
  getDeviceManager(): PlatformDeviceManager;
  getTimer(): Timer;
  getRecoveryPolicy(): DeviceRecoveryPolicy;
  completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): Promise<void>;
  recordEmulatorLossRecoveryAttempt(
    incidentId: string | undefined,
    attempt: { attempt: number; outcome: "failed" | "succeeded" },
  ): Promise<void>;
  setRecoveringAndroidImage(avdName: string, image: DeviceInfo): void;
  addRecoveringAndroidDeviceId(deviceId: string): void;
  setAndroidRecoveryHandoffOwner(deviceId: string, handoffOwner: symbol): void;
  clearAndroidRecoveryHandoffOwnerIfCurrent(deviceId: string, owner: symbol): void;
  finishAndroidRecoveryAttempt(
    avdName: string,
    recoveryDeviceIds: ReadonlySet<string>,
    retainRecoveryImage: boolean,
    replacementHandoffOwner: symbol,
    lateShutdownSettled?: Promise<unknown>,
  ): void;
  stopAndroidEmulatorForRecovery(
    device: PooledDevice,
    avdName: string,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
    allowActiveStop: boolean,
    handoffOwner: symbol,
    preservedSessionId: string | undefined,
    preservedSession: Session | undefined,
  ): Promise<"stopped" | "same-avd" | "declined">;
  rebindSameAvdReplacementSession(
    device: PooledDevice,
    avdName: string,
    preservedSessionId: string | undefined,
    preservedSession: Session | undefined,
    preservedAutolockSessionId: string | undefined,
    recoveryImage: DeviceInfo,
    handoffOwner: symbol,
  ): Promise<boolean>;
  detachSessionForAndroidRecovery(
    device: PooledDevice,
    preservedSessionId: string | undefined,
    preservedSession: Session | undefined,
  ): boolean;
  removeDevice(
    deviceId: string,
    awaitCacheCleanup?: boolean,
    expectedDevice?: PooledDevice,
  ): Promise<void>;
  addDevice(
    device: BootedDevice,
    sourceImage?: DeviceInfo,
    awaitSessionTracking?: boolean,
    identityEvidence?: IdentityEvidence,
  ): Promise<void>;
  identityEvidenceForBootedDevice(
    device: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ): IdentityEvidence;
  bindRecoveredAndroidDeviceSession(
    previousDeviceId: string,
    avdName: string,
    preservedSessionId: string | undefined,
    preservedSession: Session | undefined,
    ready: BootedDevice,
    recoveryImage: DeviceInfo,
    childProcess: ChildProcess | null,
    preservedAutolockSessionId: string | undefined,
    handoffOwner: symbol | undefined,
  ): Promise<void>;
  stopEmulatorProcess(
    childProcess: ChildProcess | null | undefined,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void>;
  consumeAndroidRecoveryCancellation(
    device: PooledDevice,
    recoveryDeviceIds: ReadonlySet<string>,
  ): boolean;
}

interface AndroidRelaunchContext {
  device: PooledDevice;
  avdName: string;
  preservedSessionId: string | undefined;
  preservedSession: Session | undefined;
  preservedAutolockSessionId: string | undefined;
  recoveryImage: DeviceInfo;
  target: DeviceInfo;
  recoveryDeviceIds: Set<string>;
  incidentId: string | undefined;
  signal: AbortSignal;
  retainLeaseUntil: (settlement: Promise<unknown>) => void;
  nextAttempt: () => number;
}

export class AndroidRebootCoordinator {
  constructor(
    private readonly pool: AndroidRebootCoordinatorPoolPort,
    private readonly androidRecoveryRecordLedger: AndroidRecoveryRecordLedger,
    private readonly criteriaMatcher: DeviceCriteriaMatcher,
    private readonly androidDeviceReboot: AndroidDeviceReboot,
  ) {}

  async rebootDisconnectedAndroidDeviceCoordinated(
    device: PooledDevice,
    incidentId: string | undefined,
    options: AndroidEmulatorRecoveryOptions,
    signal: AbortSignal,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<boolean> {
    const avdName = device.avdName;
    if (!avdName) {
      return false;
    }
    const allowActiveStop = options.allowActiveRelaunch ?? this.pool.getRecoveryPolicy().onLoss;
    const preservedSessionId = options.preserveSessionId;
    const preservedSession = options.preserveSession;
    const preservedAutolockSessionId =
      device.adbServerResetAutolockSessionId ?? device.autolockSessionId;
    const recoveryDeviceIds = new Set([device.id]);
    const recoveryImage: DeviceInfo = {
      ...device.androidImage,
      name: avdName,
      platform: "android",
      isRunning: false,
      source: "local",
    };
    const target: DeviceInfo = {
      name: avdName,
      platform: "android",
      isRunning: false,
      source: "local",
    };
    this.pool.setRecoveringAndroidImage(avdName, recoveryImage);
    this.trackAndroidRecoveryImageReservation(preservedSessionId);
    this.pool.addRecoveringAndroidDeviceId(device.id);
    const replacementHandoffOwner = Symbol("same-avd-recovery-handoff");
    let recoveryAttempt = 0;
    let retainRecoveryImage = false;
    // Late kills this attempt fenced via the lifecycle lease. When the image is
    // retained, the pool lifts it only after these settle and a fresh
    // observation proves the AVD's state (see finishAndroidRecoveryAttempt).
    const lateShutdowns = trackLateShutdowns(retainLeaseUntil);
    try {
      let replacementState: "stopped" | "same-avd" | "declined";
      try {
        replacementState = await this.pool.stopAndroidEmulatorForRecovery(
          device,
          avdName,
          lateShutdowns.retainLeaseUntil,
          allowActiveStop,
          replacementHandoffOwner,
          preservedSessionId,
          preservedSession,
        );
      } catch (error) {
        logger.warn(
          `[DevicePool] Could not terminate disconnected emulator ${device.id}: ${error}`,
          error,
        );
        if (error instanceof UnconfirmedRecoveryShutdownError) {
          retainRecoveryImage = true;
          throw error;
        }
        await this.pool.completeEmulatorLossRecovery(incidentId, "exhausted");
        return false;
      }
      if (replacementState !== "stopped") {
        return await this.finishAndroidRecoveryWithoutActiveStop(replacementState, {
          device,
          avdName,
          preservedSessionId,
          preservedSession,
          preservedAutolockSessionId,
          recoveryImage,
          incidentId,
          handoffOwner: replacementHandoffOwner,
        });
      }
      if (
        !this.pool.detachSessionForAndroidRecovery(device, preservedSessionId, preservedSession)
      ) {
        await this.pool.completeEmulatorLossRecovery(incidentId, "not-attempted");
        return false;
      }
      await this.pool.removeDevice(device.id, true, device);
      const { recovered, intentionallyStopped, intentionalShutdownCleanupError } =
        await this.runAndroidRelaunch({
          device,
          avdName,
          preservedSessionId,
          preservedSession,
          preservedAutolockSessionId,
          recoveryImage,
          target,
          recoveryDeviceIds,
          incidentId,
          signal,
          retainLeaseUntil,
          nextAttempt: () => ++recoveryAttempt,
        });
      if (intentionallyStopped) {
        if (intentionalShutdownCleanupError !== undefined) {
          throw intentionalShutdownCleanupError;
        }
        logger.info(
          `[DevicePool] Cancelled Android emulator ${avdName} recovery after intentional shutdown`,
        );
        await this.pool.completeEmulatorLossRecovery(incidentId, "not-attempted");
        return false;
      }
      if (recovered) {
        logger.info(`[DevicePool] Restarted Android emulator ${avdName} after disconnect`);
      }
      await this.pool.completeEmulatorLossRecovery(
        incidentId,
        recovered ? "recovered" : "exhausted",
      );
      return recovered;
    } finally {
      this.pool.finishAndroidRecoveryAttempt(
        avdName,
        recoveryDeviceIds,
        retainRecoveryImage,
        replacementHandoffOwner,
        lateShutdowns.settledWhen(retainRecoveryImage),
      );
    }
  }

  private async runAndroidRelaunch({
    device,
    avdName,
    preservedSessionId,
    preservedSession,
    preservedAutolockSessionId,
    recoveryImage,
    target,
    recoveryDeviceIds,
    incidentId,
    signal,
    retainLeaseUntil,
    nextAttempt,
  }: AndroidRelaunchContext): Promise<{
    recovered: boolean;
    intentionallyStopped: boolean;
    intentionalShutdownCleanupError: unknown;
  }> {
    let intentionallyStopped = false;
    let intentionalShutdownCleanupError: unknown;
    const recovered = await this.androidDeviceReboot.run(target, async () => {
      if (this.pool.consumeAndroidRecoveryCancellation(device, recoveryDeviceIds)) {
        intentionallyStopped = true;
        // Cancelled before the emulator was touched: don't spend the
        // crash-loop budget on it (issue #7545).
        return "cancelled";
      }
      const attempt = nextAttempt();
      let childProcess: ChildProcess | null = null;
      let ready: BootedDevice | undefined;
      let readinessCompleted = false;
      let handoffOwner: symbol | undefined;
      let ownedBootSettlementAttempted = false;
      let ownedBootSettlementError: unknown;
      const settleOwnedBoot = async (): Promise<void> => {
        ownedBootSettlementAttempted = true;
        try {
          await this.pool.stopEmulatorProcess(childProcess, retainLeaseUntil);
        } catch (error) {
          ownedBootSettlementError = error;
          throw error;
        }
      };
      const stopCancelledRecovery = async (deviceToRemove?: BootedDevice): Promise<void> => {
        intentionallyStopped = true;
        if (deviceToRemove) {
          try {
            await this.pool.removeDevice(deviceToRemove.deviceId);
          } catch (error) {
            intentionalShutdownCleanupError = error;
          }
        }
        try {
          await this.pool.stopEmulatorProcess(childProcess, retainLeaseUntil);
        } catch (error) {
          intentionalShutdownCleanupError ??= error;
        }
      };
      const finishCancelledRecovery = async (): Promise<void> => {
        if (ownedBootSettlementAttempted) {
          intentionallyStopped = true;
          intentionalShutdownCleanupError ??= ownedBootSettlementError;
          return;
        }
        await stopCancelledRecovery(readinessCompleted ? ready : undefined);
      };
      try {
        childProcess = await this.pool.getDeviceManager().startDevice(target);
        ready = this.criteriaMatcher.withDeviceImageMetadata(
          await waitForDeviceReadyOrCancel(
            this.pool.getDeviceManager(),
            target,
            childProcess,
            undefined,
            signal,
            this.pool.getTimer(),
            settleOwnedBoot,
          ),
          recoveryImage,
        );
        readinessCompleted = true;
        recoveryDeviceIds.add(ready.deviceId);
        this.pool.addRecoveringAndroidDeviceId(ready.deviceId);
        handoffOwner = Symbol("android-recovery-handoff");
        this.pool.setAndroidRecoveryHandoffOwner(ready.deviceId, handoffOwner);
        if (this.pool.consumeAndroidRecoveryCancellation(device, recoveryDeviceIds)) {
          await stopCancelledRecovery();
          return;
        }
        await this.pool.addDevice(
          ready,
          recoveryImage,
          true,
          this.pool.identityEvidenceForBootedDevice(ready),
        );
        if (this.pool.consumeAndroidRecoveryCancellation(device, recoveryDeviceIds)) {
          await stopCancelledRecovery(ready);
          return;
        }
        await this.pool.bindRecoveredAndroidDeviceSession(
          device.id,
          avdName,
          preservedSessionId,
          preservedSession,
          ready,
          recoveryImage,
          childProcess,
          preservedAutolockSessionId,
          handoffOwner,
        );
        await this.pool.recordEmulatorLossRecoveryAttempt(incidentId, {
          attempt,
          outcome: "succeeded",
        });
      } catch (error) {
        if (
          signal.aborted ||
          this.pool.consumeAndroidRecoveryCancellation(device, recoveryDeviceIds)
        ) {
          await finishCancelledRecovery();
          return;
        }
        await this.pool.recordEmulatorLossRecoveryAttempt(incidentId, {
          attempt,
          outcome: "failed",
        });
        throw error;
      } finally {
        if (handoffOwner !== undefined && ready !== undefined) {
          this.pool.clearAndroidRecoveryHandoffOwnerIfCurrent(ready.deviceId, handoffOwner);
        }
      }
    });
    return { recovered, intentionallyStopped, intentionalShutdownCleanupError };
  }

  private trackAndroidRecoveryImageReservation(sessionId: string | undefined): void {
    if (!sessionId) {
      return;
    }
    this.androidRecoveryRecordLedger.recoveringSessionLosses
      .get(sessionId)
      ?.reservations.add("image");
  }

  private async finishAndroidRecoveryWithoutActiveStop(
    replacementState: "same-avd" | "declined",
    context: SameAvdRecoveryContext,
  ): Promise<boolean> {
    if (replacementState === "declined") {
      return false;
    }
    return await this.recoverSameAvdReplacement(context);
  }

  private async recoverSameAvdReplacement({
    device,
    avdName,
    preservedSessionId,
    preservedSession,
    preservedAutolockSessionId,
    recoveryImage,
    incidentId,
    handoffOwner,
  }: SameAvdRecoveryContext): Promise<boolean> {
    if (
      !(await this.pool.rebindSameAvdReplacementSession(
        device,
        avdName,
        preservedSessionId,
        preservedSession,
        preservedAutolockSessionId,
        recoveryImage,
        handoffOwner,
      ))
    ) {
      return false;
    }
    await this.pool.completeEmulatorLossRecovery(incidentId, "recovered");
    return true;
  }
}
