import { isUnresolvedAndroidEmulatorName } from "../../../devices/deviceIdentityEvidence";
import {
  emulatorProcessArguments,
  isEmulatorQemuProcess,
  serialPort,
  type EmulatorProcessTableSource,
} from "../../../utils/android-cmdline-tools/EmulatorProcessStop";
import type { AdbDeviceState } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { isAndroidEmulatorSerial } from "../../../utils/androidSerial";
import type { PlatformDeviceManager } from "../../../devices/deviceUtils";
import { ActionableError } from "../../../models/ActionableError";
import type { BootedDevice, DeviceInfo } from "../../../models/DeviceInfo";
import { isProductBrokerDevice } from "../persistedIdentity";
import type { LegacySlotDeviceStopper, LegacySlotDeviceTarget } from "./legacySlotDeviceRetirement";

/** Same platform shutdown port used by killDevice; no image-destruction API is exposed here. */
export class PlatformLegacySlotDeviceStopper implements LegacySlotDeviceStopper {
  constructor(
    private readonly manager: Pick<
      PlatformDeviceManager,
      "getDeviceImagesDetailed" | "getBootedDevicesDetailed" | "killDevice"
    >,
    private readonly android: {
      processes: EmulatorProcessTableSource;
      readStates(signal: AbortSignal): Promise<AdbDeviceState[]>;
    },
  ) {}

  async inspect(
    target: LegacySlotDeviceTarget,
    signal: AbortSignal,
  ): Promise<DeviceInfo | undefined> {
    const images = await this.manager.getDeviceImagesDetailed(target.platform, {
      signal,
      bypassIosDeviceListCache: true,
    });
    const running = await this.manager.getBootedDevicesDetailed(target.platform, {
      signal,
      bypassAndroidDeviceListCache: true,
      bypassIosDeviceListCache: true,
      skipPhysicalIosDiscovery: true,
    });
    this.assertComplete(target, images, running);
    const matches = (device: { name: string; deviceId?: string }) =>
      target.stableId
        ? (target.platform === "android" ? device.name : device.deviceId) === target.stableId
        : device.name === target.name;
    const image = images.devices.find(matches);
    const booted = running.devices.find(
      (device) =>
        matches(device) &&
        (target.platform !== "android" || isAndroidEmulatorSerial(device.deviceId)),
    );
    const transitional = running.transitionalSimulators?.some((device) => matches(device.device));
    if (transitional) {
      throw new ActionableError(
        "Legacy simulator is transitioning; retry retirement after it settles",
      );
    }
    if (target.platform === "android" && !booted && image?.isRunningStateKnown === false) {
      throw new ActionableError("Legacy Android running state is unconfirmed");
    }
    if (target.platform === "android" && !booted) {
      await this.assertAndroidStopped(target, signal);
    }
    return this.currentDevice(target, image, booted);
  }

  private currentDevice(
    target: LegacySlotDeviceTarget,
    image: DeviceInfo | undefined,
    booted: BootedDevice | undefined,
  ): DeviceInfo | undefined {
    const current = booted ?? image;
    if (!current) {
      return undefined;
    }
    return {
      ...image,
      ...booted,
      name: current.name,
      platform: target.platform,
      isRunning: booted !== undefined || image?.isRunning === true,
      isRunningStateKnown: image?.isRunningStateKnown,
    };
  }

  private assertComplete(
    target: LegacySlotDeviceTarget,
    images: Awaited<ReturnType<PlatformDeviceManager["getDeviceImagesDetailed"]>>,
    running: Awaited<ReturnType<PlatformDeviceManager["getBootedDevicesDetailed"]>>,
  ): void {
    const completed =
      target.platform === "ios"
        ? running.succeededSources?.has("ios-simulator")
        : running.succeededPlatforms.has("android");
    if (!images.succeededPlatforms.has(target.platform) || !completed) {
      throw new ActionableError(
        `Cannot confirm legacy ${target.platform} device inventory; retry with the platform tooling available`,
      );
    }
    // An unidentified emulator may be this AVD; absence is not proof of shutdown.
    if (target.platform === "android" && running.devices.some(isUnresolvedAndroidEmulatorName)) {
      throw new ActionableError(
        "Cannot confirm legacy shutdown while an Android runtime has unresolved identity",
      );
    }
  }

  private async assertAndroidStopped(
    target: LegacySlotDeviceTarget,
    signal: AbortSignal,
  ): Promise<void> {
    // Read the process table last so port identity evidence is newer than ADB state.
    const states = await this.android.readStates(signal);
    const processes = await this.android.processes.read({ signal });
    if (!processes.value) {
      throw new ActionableError(
        `Cannot confirm legacy emulator process absence: ${processes.error ?? "process table unavailable"}`,
      );
    }
    // Online-only discovery omits offline emulators. Only a unique, explicitly port-matched
    // non-product AVD proves that an omitted emulator cannot be a legacy product device.
    for (const state of states) {
      if (!isAndroidEmulatorSerial(state.deviceId) || state.state === "device") {
        continue;
      }
      const port = serialPort(state.deviceId);
      const matches = processes.value
        .filter(isEmulatorQemuProcess)
        .map((row) => emulatorProcessArguments(row.command))
        .filter((args) => args.port === port);
      if (
        matches.length !== 1 ||
        !matches[0].avdName ||
        isProductBrokerDevice(matches[0].avdName)
      ) {
        throw new ActionableError(
          "Cannot confirm legacy shutdown while an Android emulator is offline or unauthorized",
        );
      }
    }
    if (processes.value.some((row) => this.mayBeTargetProcess(row, target))) {
      throw new ActionableError(
        "Legacy emulator process is still running; retry retirement after it exits",
      );
    }
  }

  private mayBeTargetProcess(row: { command: string }, target: LegacySlotDeviceTarget): boolean {
    if (!isEmulatorQemuProcess(row)) {
      return false;
    }
    const { avdName } = emulatorProcessArguments(row.command);
    return !avdName || avdName === (target.stableId ?? target.name);
  }

  async stop(device: DeviceInfo, signal: AbortSignal): Promise<void> {
    if (!device.deviceId) {
      throw new ActionableError(`Legacy device '${device.name}' has no confirmed runtime id`);
    }
    await this.manager.killDevice(
      { ...device, deviceId: device.deviceId },
      { signal, timeoutMs: 30_000 },
    );
  }
}
