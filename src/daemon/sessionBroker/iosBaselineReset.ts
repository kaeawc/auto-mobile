import type { BrokerNativeProfile } from "./profile";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import type { IosBootInstrumentation } from "../../models/IosBootInstrumentation";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import type { BootedDevice, DeviceInfo } from "../../models/DeviceInfo";
import type { AppleDevice, SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { normalizeIosVersion } from "../../utils/ios-cmdline-tools/SimCtlSupport";
import { compareIosVersions } from "../../utils/ios-cmdline-tools/iosVersion";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import type { ResetOutcome } from "./devicePort";
import { ResetFailureError } from "./ResetFailureError";
import { errorMessage } from "../../utils/describeUnknownError";

type IosProfile = Extract<BrokerNativeProfile, { platform: "ios" }>;
type ResetSimctl = Pick<SimCtl, "readSimulatorTarget" | "eraseSimulator" | "bootSimulator">;
type ExpectedState = "Booted" | "Shutdown";

export class IosBaselineReset {
  private readonly deferredBoots = new Set<string>();

  constructor(
    private readonly dependencies: {
      simctl: ResetSimctl;
      iosBootInstrumentation: IosBootInstrumentation;
      stopDevice: (device: BootedDevice) => Promise<void>;
    },
    private readonly timer: Pick<Timer, "now"> = defaultTimer,
  ) {}

  async reset(
    device: BootedDevice,
    profile: IosProfile,
    assertOwned: () => Promise<void>,
  ): Promise<"clean"> {
    await this.runReset(device, profile, assertOwned, {});
    return "clean";
  }

  async resetWithTiming(
    device: BootedDevice,
    profile: IosProfile,
    assertOwned: () => Promise<void>,
  ): Promise<ResetOutcome> {
    const phases: Record<string, number> = {};
    try {
      return await this.runReset(device, profile, assertOwned, phases);
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
  ): Promise<ResetOutcome> {
    this.assertInput(device, profile);
    // Only a capacity refusal from this resetter permits a shut-down retry. Re-erase below:
    // ownership and inventory are checked again, so a retry never trusts an old clean result.
    const deferredBoot = this.deferredBoots.delete(device.deviceId);
    await this.readExpectedTarget(
      device.deviceId,
      profile,
      deferredBoot ? "Shutdown" : "Booted",
      "start reset",
    );

    await assertOwned();
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
      this.bootAdmitted(device.deviceId, profile, assertOwned),
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
  ): Promise<BootedDevice> {
    try {
      return await this.dependencies.iosBootInstrumentation.run(
        // The callback ignores remainingMs; bootSimulator uses its own timeout.
        { udid, runtime: profile.runtimeId, timeoutMs: DEFAULT_DEVICE_READY_TIMEOUT_MS },
        async () => {
          // Admission samples asynchronously; fence ownership immediately before the mutation.
          await assertOwned();
          return this.dependencies.simctl.bootSimulator(udid);
        },
      );
    } catch (error) {
      if (error instanceof BootCapacityExhaustedError) {
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

  private assertInput(device: BootedDevice, profile: IosProfile): void {
    if (device.platform !== "ios" || !device.deviceId.trim()) {
      throw new ActionableError("iOS baseline reset requires an exact iOS simulator UDID");
    }
    if (
      profile.platform !== "ios" ||
      !profile.simulatorDeviceTypeIdentifier.trim() ||
      !profile.runtimeId.trim() ||
      !profile.osVersion.trim()
    ) {
      throw new ActionableError("iOS baseline reset requires a complete exact iOS profile");
    }
    if (profile.archetype === "duo" || profile.modelType.family === "duo") {
      throw new ActionableError("iOS baseline reset does not support Duo devices");
    }
  }

  private async readExpectedTarget(
    udid: string,
    profile: IosProfile,
    expectedState: ExpectedState,
    action: string,
  ): Promise<void> {
    let target: AppleDevice | undefined;
    try {
      target = await this.dependencies.simctl.readSimulatorTarget(udid);
    } catch (error) {
      throw toActionableError(error, `Cannot ${action}: fresh iOS simulator inventory failed`);
    }

    if (!target || target.udid !== udid) {
      throw new ActionableError(
        `Cannot ${action}: fresh iOS simulator inventory did not prove one exact target '${udid}'`,
      );
    }
    const iosVersion = normalizeIosVersion(target.runtime, target.os_version);
    this.assertTarget(
      {
        name: target.name,
        deviceId: target.udid,
        platform: "ios",
        isRunning: target.state === "Booted",
        state: target.state,
        isAvailable: target.isAvailable,
        deviceType: target.deviceTypeIdentifier,
        runtimeId: target.runtime,
        runtime: target.runtime,
        osVersion: iosVersion,
        iosVersion,
      },
      profile,
      expectedState,
      action,
    );
  }

  private assertTarget(
    target: DeviceInfo,
    profile: IosProfile,
    expectedState: ExpectedState,
    action: string,
  ): void {
    const expectedRunning = expectedState === "Booted";
    const targetMatches = [
      target.platform === "ios",
      target.isAvailable === true,
      target.deviceType === profile.simulatorDeviceTypeIdentifier,
      target.runtimeId === profile.runtimeId,
      target.runtime === undefined || target.runtime === profile.runtimeId,
      compareIosVersions(target.osVersion, profile.osVersion) === 0,
      target.iosVersion === undefined ||
        compareIosVersions(target.iosVersion, profile.osVersion) === 0,
      target.state === expectedState,
      target.isRunning === expectedRunning,
      target.isRunningStateKnown !== false,
    ].every(Boolean);

    if (!targetMatches) {
      throw new ActionableError(
        `Cannot ${action}: simulator '${target.deviceId}' lacks authoritative ${expectedState} ` +
          "identity, runtime, type, OS, or availability evidence",
      );
    }
  }
}
