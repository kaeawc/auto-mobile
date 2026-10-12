import type { BrokerNativeProfile } from "./profile";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice, DeviceInfo } from "../../models/DeviceInfo";
import type { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { compareIosVersions } from "../../utils/ios-cmdline-tools/iosVersion";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";

type IosProfile = Extract<BrokerNativeProfile, { platform: "ios" }>;
type ResetSimctl = Pick<SimCtlClient, "listSimulatorImages" | "eraseSimulator" | "bootSimulator">;
type ExpectedState = "Booted" | "Shutdown";

export class IosBaselineReset {
  constructor(
    private readonly dependencies: {
      simctl: ResetSimctl;
      stopDevice: (device: BootedDevice) => Promise<void>;
    },
    private readonly timer: Pick<Timer, "now"> = defaultTimer,
  ) {}

  async reset(
    device: BootedDevice,
    profile: IosProfile,
    assertOwned: () => Promise<void>,
  ): Promise<"clean"> {
    this.assertInput(device, profile);
    await this.readExpectedTarget(device.deviceId, profile, "Booted", "start reset");

    await assertOwned();
    await this.measureStep(device.deviceId, "stop", () => this.dependencies.stopDevice(device));

    await this.readExpectedTarget(device.deviceId, profile, "Shutdown", "erase simulator");
    await assertOwned();
    await this.measureStep(device.deviceId, "erase", () =>
      this.dependencies.simctl.eraseSimulator(device.deviceId),
    );

    await assertOwned();
    const booted = await this.measureStep(device.deviceId, "boot", () =>
      this.dependencies.simctl.bootSimulator(device.deviceId),
    );
    if (booted.platform !== "ios" || booted.deviceId !== device.deviceId) {
      throw new ActionableError(
        `iOS baseline reset booted a different target instead of simulator '${device.deviceId}'`,
      );
    }

    await this.readExpectedTarget(device.deviceId, profile, "Booted", "confirm clean baseline");
    await assertOwned();
    return "clean";
  }

  private async measureStep<T>(
    deviceId: string,
    phase: string,
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
    let inventory: DeviceInfo[];
    try {
      inventory = await this.dependencies.simctl.listSimulatorImages(undefined, {
        bypassCache: true,
      });
    } catch (error) {
      throw toActionableError(error, `Cannot ${action}: fresh iOS simulator inventory failed`);
    }

    const matches = inventory.filter((candidate) => candidate.deviceId === udid);
    if (matches.length !== 1) {
      throw new ActionableError(
        `Cannot ${action}: fresh iOS simulator inventory did not prove one exact target '${udid}'`,
      );
    }
    this.assertTarget(matches[0]!, profile, expectedState, action);
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
