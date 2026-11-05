import type { BootedDevice, DeviceInfo } from "../../models";
import type { IosBootInstrumentation } from "../../models/IosBootInstrumentation";
import { getAbortSignal } from "../AbortContext";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../deviceTimeouts";
import type { SimCtl } from "./SimCtlClient";

export type ListedAppleVision = DeviceInfo & { deviceId: string };
export type AppleVisionBootAdmission = Pick<IosBootInstrumentation, "run">;
export type AppleVisionBootSimctl = Pick<SimCtl, "waitForSimulatorReady">;
export interface AppleVisionBootResult {
  device: BootedDevice;
  acquisition: "already-booted" | "cold-boot";
}

/** Boots an inventory-resolved Apple Vision Pro under the shared host simulator capacity limit. */
export class AppleVisionSimulatorBoot {
  constructor(
    private readonly simctl: AppleVisionBootSimctl,
    private readonly admission?: AppleVisionBootAdmission,
  ) {}

  async boot(
    headset: ListedAppleVision,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<AppleVisionBootResult> {
    if (headset.isRunning) {
      return {
        device: { name: headset.name, platform: "visionos", deviceId: headset.deviceId },
        acquisition: "already-booted",
      };
    }
    const boot = () => this.simctl.waitForSimulatorReady(headset.deviceId, options.timeoutMs);
    const booted = this.admission
      ? await this.admission.run(
          {
            udid: headset.deviceId,
            reason: "restart",
            runtime: headset.runtimeId,
            timeoutMs: options.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS,
            signal: options.signal ?? getAbortSignal(),
          },
          boot,
        )
      : await boot();
    // The shared simctl boot returns an iOS label; inventory established the visionOS identity.
    return { device: { ...booted, platform: "visionos" }, acquisition: "cold-boot" };
  }
}
