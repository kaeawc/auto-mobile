import type { BrokerNativeProfile } from "./profile";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { BootedDeviceDiscoveryIncompleteError } from "../../models/BootedDeviceDiscoveryIncompleteError";
import { exponentialBackoff } from "../../utils/Backoff";
import { ResetCapacityWaitExceededError } from "../../models/ResetCapacityWaitExceededError";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import type { IosBootInstrumentation } from "../../models/IosBootInstrumentation";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import type { BootedDevice } from "../../models/DeviceInfo";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import type { ResetOutcome } from "./devicePort";
import { ResetFailureError } from "./ResetFailureError";
import { errorMessage } from "../../utils/describeUnknownError";
import type { BootSlotReservation } from "../../devices/bootAdmission/BootSlotReservation";
import { assertIosResetInput, readExpectedIosResetTarget } from "./iosResetTarget";

type IosProfile = Extract<BrokerNativeProfile, { platform: "ios" }>;
type ResetSimctl = Pick<SimCtl, "readSimulatorTarget" | "eraseSimulator" | "bootSimulator">;
type ExpectedState = "Booted" | "Shutdown";

export const IOS_RESET_CAPACITY_WAIT_MS = 60_000;

export class IosBaselineReset {
  private readonly deferredBoots = new Set<string>();

  constructor(
    private readonly dependencies: {
      simctl: ResetSimctl;
      iosBootInstrumentation: IosBootInstrumentation;
      stopDevice: (device: BootedDevice) => Promise<void>;
    },
    private readonly timer: Pick<Timer, "now" | "sleep"> = defaultTimer,
  ) {}

  async reset(
    device: BootedDevice,
    profile: IosProfile,
    assertOwned: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<"clean"> {
    await this.runReset(device, profile, assertOwned, {}, signal);
    return "clean";
  }

  async resetWithTiming(
    device: BootedDevice,
    profile: IosProfile,
    assertOwned: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<ResetOutcome> {
    const phases: Record<string, number> = {};
    try {
      return await this.runReset(device, profile, assertOwned, phases, signal);
    } catch (error) {
      throw new ResetFailureError(
        errorMessage(error),
        {
          outcome: "pending",
          mode: "erase",
          phases,
          fallbackReason: errorMessage(error),
        },
        { cause: error },
      );
    }
  }

  private async runReset(
    device: BootedDevice,
    profile: IosProfile,
    assertOwned: () => Promise<void>,
    phases: Record<string, number>,
    signal?: AbortSignal,
  ): Promise<ResetOutcome> {
    const owned = async () => {
      signal?.throwIfAborted();
      await assertOwned();
      signal?.throwIfAborted();
    };
    assertIosResetInput(device, profile);
    // Pre-boot capacity or discovery refusals permit a shut-down retry. Re-erase below:
    // ownership and inventory are checked again, so a retry never trusts an old clean result.
    const deferredBoot = this.deferredBoots.delete(device.deviceId);
    await this.readExpectedTarget(
      device.deviceId,
      profile,
      deferredBoot ? "Shutdown" : "Booted",
      "start reset",
    );

    await owned();
    let reservation: BootSlotReservation | undefined;
    try {
      reservation = await this.reserveResetBoot(device.deviceId, owned, signal);
    } catch (error) {
      // Reservation and its ownership fences cannot mutate the simulator. Preserve the
      // authoritative Shutdown retry marker even when backoff is interrupted.
      if (deferredBoot) {
        this.deferredBoots.add(device.deviceId);
      }
      throw toActionableError(error, "Cannot reserve iOS reset boot slot");
    }
    const operation = () => this.eraseAndBoot(device, profile, owned, phases, deferredBoot, signal);
    try {
      return await (reservation ? reservation.run(operation) : operation());
    } finally {
      reservation?.release();
    }
  }

  private async reserveResetBoot(
    deviceId: string,
    owned: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<BootSlotReservation | undefined> {
    const startedAt = this.timer.now();
    let deadline = startedAt + DEFAULT_DEVICE_READY_TIMEOUT_MS;
    const backoff = exponentialBackoff({ initialDelayMs: 1_000, maxDelayMs: 8_000 });
    let attempt = 0;
    let capacityAttempt = 0;
    for (;;) {
      signal?.throwIfAborted();
      const attemptStartedAt = this.timer.now();
      try {
        return await this.dependencies.iosBootInstrumentation.reserveBoot?.({
          replacingDeviceId: deviceId,
          timeoutMs: deadline - this.timer.now(),
          reason: "reset",
          signal,
        });
      } catch (error) {
        if (error instanceof BootCapacityExhaustedError) {
          await this.waitResetCapacity({
            error,
            deviceId,
            startedAt,
            owned,
            delayMs: backoff.delayForAttempt(++capacityAttempt),
          });
          // Time spent waiting on capacity is not charged to the discovery budget.
          deadline += this.timer.now() - attemptStartedAt;
          continue;
        }
        const delayMs = backoff.delayForAttempt(++attempt);
        if (
          !(error instanceof BootedDeviceDiscoveryIncompleteError) ||
          deadline - this.timer.now() <= delayMs
        ) {
          throw toActionableError(error, "Cannot reserve iOS reset boot slot");
        }
        await this.timer.sleep(delayMs);
        await owned();
        if (this.timer.now() >= deadline) {
          throw toActionableError(error, "Cannot reserve iOS reset boot slot");
        }
      }
    }
  }

  private async waitResetCapacity(options: {
    error: BootCapacityExhaustedError;
    deviceId: string;
    startedAt: number;
    owned: () => Promise<void>;
    delayMs: number;
  }): Promise<void> {
    const { error, deviceId, startedAt, owned, delayMs } = options;
    const deadline = startedAt + IOS_RESET_CAPACITY_WAIT_MS;
    if (this.timer.now() + delayMs > deadline || this.timer.now() >= deadline) {
      throw new ResetCapacityWaitExceededError(deviceId, this.timer.now() - startedAt, error);
    }
    await this.timer.sleep(delayMs);
    await owned();
    if (this.timer.now() >= deadline) {
      throw new ResetCapacityWaitExceededError(deviceId, this.timer.now() - startedAt, error);
    }
  }

  private async eraseAndBoot(
    device: BootedDevice,
    profile: IosProfile,
    assertOwned: () => Promise<void>,
    phases: Record<string, number>,
    deferredBoot: boolean,
    signal?: AbortSignal,
  ): Promise<ResetOutcome> {
    if (this.dependencies.iosBootInstrumentation.reserveBoot) {
      await assertOwned();
    }
    if (!deferredBoot) {
      await this.measureStep(device.deviceId, "stop", phases, () =>
        this.dependencies.stopDevice(device),
      );
    }

    await this.readExpectedTarget(device.deviceId, profile, "Shutdown", "erase simulator");
    await assertOwned();
    await this.measureStep(device.deviceId, "erase", phases, () =>
      this.dependencies.simctl.eraseSimulator(device.deviceId),
    );

    const booted = await this.measureStep(device.deviceId, "boot", phases, () =>
      this.bootAdmitted(device.deviceId, profile, assertOwned, signal),
    );
    if (booted.platform !== "ios" || booted.deviceId !== device.deviceId) {
      throw new ActionableError(
        `iOS baseline reset booted a different target instead of simulator '${device.deviceId}'`,
      );
    }

    await this.readExpectedTarget(device.deviceId, profile, "Booted", "confirm clean baseline");
    await assertOwned();
    return { outcome: "clean", mode: "erase", phases };
  }

  private async bootAdmitted(
    udid: string,
    profile: IosProfile,
    assertOwned: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<BootedDevice> {
    let callbackStarted = false;
    try {
      return await this.dependencies.iosBootInstrumentation.run(
        // The callback ignores remainingMs; bootSimulator uses its own timeout.
        {
          udid,
          runtime: profile.runtimeId,
          timeoutMs: DEFAULT_DEVICE_READY_TIMEOUT_MS,
          reason: "reset",
          signal,
        },
        async () => {
          callbackStarted = true;
          // Admission samples asynchronously; fence ownership immediately before the mutation.
          await assertOwned();
          return this.dependencies.simctl.bootSimulator(udid);
        },
      );
    } catch (error) {
      if (
        error instanceof BootCapacityExhaustedError ||
        (!callbackStarted && error instanceof BootedDeviceDiscoveryIncompleteError)
      ) {
        this.deferredBoots.add(udid);
      }
      throw toActionableError(error, "Cannot boot erased iOS simulator");
    }
  }

  private async measureStep<T>(
    deviceId: string,
    phase: string,
    phases: Record<string, number>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = this.timer.now();
    let completed = false;
    logger.info(`[SessionBroker] iOS baseline reset ${phase} started for ${deviceId}`);
    try {
      const result = await operation();
      completed = true;
      return result;
    } finally {
      phases[phase] = this.timer.now() - started;
      logger.info(
        `[SessionBroker] iOS baseline reset ${phase} ${completed ? "completed" : "failed"} ` +
          `for ${deviceId} after ${this.timer.now() - started}ms`,
      );
    }
  }

  private async readExpectedTarget(
    udid: string,
    profile: IosProfile,
    expectedState: ExpectedState,
    action: string,
  ): Promise<void> {
    await readExpectedIosResetTarget(
      this.dependencies.simctl,
      udid,
      profile,
      expectedState,
      action,
    );
  }
}
