import type { BootedDevice, DeviceInfo } from "../../models";
import type { IosBootInstrumentation } from "../../models/IosBootInstrumentation";
import { getAbortSignal } from "../AbortContext";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../deviceTimeouts";
import type { SimCtl } from "./SimCtlClient";

export type ListedAppleVision = DeviceInfo & { deviceId: string };
export type AppleVisionBootAdmission = Pick<IosBootInstrumentation, "run">;
export type AppleVisionBootSimctl = Pick<SimCtl, "waitForSimulatorReady" | "killSimulator">;
export interface AppleVisionBootResult {
  device: BootedDevice;
  acquisition: "already-booted" | "cold-boot";
}

/** Cleanup of a cold boot must outlive the cancellation that made it necessary. */
const STOP_COLD_BOOT_TIMEOUT_MS = 30_000;

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

  /**
   * Stops a headset that `boot` cold-booted; an adopted, already running headset is left alone.
   * A Vision boot has no process handle, so the stop is a `simctl shutdown` of its UDID.
   */
  async stopColdBooted(boot: AppleVisionBootResult): Promise<void> {
    if (boot.acquisition !== "cold-boot") {
      return;
    }
    await this.simctl.killSimulator(boot.device, {
      timeoutMs: STOP_COLD_BOOT_TIMEOUT_MS,
      signal: AbortSignal.timeout(STOP_COLD_BOOT_TIMEOUT_MS),
    });
  }
}
