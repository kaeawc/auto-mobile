import type { BootedDevice, DeviceInfo } from "../../models";
import type { IosBootInstrumentation } from "../../models/IosBootInstrumentation";
import { getAbortSignal } from "../AbortContext";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../deviceTimeouts";
import type { SimCtl } from "./SimCtlClient";

export type ListedAppleTv = DeviceInfo & { deviceId: string };
export type AppleTvBootAdmission = Pick<IosBootInstrumentation, "run">;
export type AppleTvBootSimctl = Pick<SimCtl, "waitForSimulatorReady">;
export interface AppleTvBootResult {
  device: BootedDevice;
  acquisition: "already-booted" | "cold-boot";
}

/** Boots an inventory-resolved Apple TV under the shared host simulator capacity limit. */
export class AppleTvSimulatorBoot {
  constructor(
    private readonly simctl: AppleTvBootSimctl,
    private readonly admission?: AppleTvBootAdmission,
  ) {}

  async boot(
    tv: ListedAppleTv,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<AppleTvBootResult> {
    if (tv.isRunning) {
      return {
        device: { name: tv.name, platform: "tvos", deviceId: tv.deviceId },
        acquisition: "already-booted",
      };
    }
    const boot = () => this.simctl.waitForSimulatorReady(tv.deviceId, options.timeoutMs);
    const booted = this.admission
      ? await this.admission.run(
          {
            udid: tv.deviceId,
            reason: "restart",
            runtime: tv.runtimeId,
            timeoutMs: options.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS,
            signal: options.signal ?? getAbortSignal(),
          },
          boot,
        )
      : await boot();
    // The shared simctl boot returns an iOS label; inventory established the tvOS identity.
    return { device: { ...booted, platform: "tvos" }, acquisition: "cold-boot" };
  }
}
