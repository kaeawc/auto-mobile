import type { BootedDevice } from "../models";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import { AndroidDemoModeStatusBarController } from "../features/utility/AndroidDemoModeStatusBarController";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../utils/logger";
import { awaitWhileRequestIsLive } from "../utils/toolUtils";
import type { ToolMutation } from "./deviceMutationAdapters";
import { STATUS_BAR_MUTATION } from "./deviceMutationAppearanceAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

function isStatusBar(entry: ToolMutation): boolean {
  return entry.kind === STATUS_BAR_MUTATION.kind && entry.key === STATUS_BAR_MUTATION.key;
}

/**
 * Reads the trustworthy prior of the Appearance intents; every other intent stays unobservable.
 * - Android: the `sysui_demo_allowed` value the device holds before demo mode is switched on
 *   (`absent` when the setting is unset), the one value reset must put back.
 * - iOS Simulator: `absent`. Every keep-booted reset and every erase clears the simulator's
 *   status-bar override (`simctl status_bar clear`), so a session starts without one.
 */
export class AppearanceMutationPriorReader implements MutationPriorReader {
  constructor(
    private readonly demoAllowedFor: (
      device: BootedDevice,
    ) => Pick<AndroidDemoModeStatusBarController, "readDemoAllowed"> = (device) =>
      new AndroidDemoModeStatusBarController(
        defaultAdbClientFactory.create(device),
        device.deviceId,
      ),
  ) {}

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    const statusBar = mutations.some(isStatusBar)
      ? await this.readStatusBar(device, signal)
      : ({ state: "unobservable" } satisfies MutationValue);
    return mutations.map((entry): MutationValue =>
      isStatusBar(entry) ? statusBar : { state: "unobservable" },
    );
  }

  private async readStatusBar(device: BootedDevice, signal?: AbortSignal): Promise<MutationValue> {
    if (device.platform === "ios") {
      return { state: "absent" };
    }
    try {
      const demoAllowed = await awaitWhileRequestIsLive(
        this.demoAllowedFor(device).readDemoAllowed(signal),
        signal,
      );
      return demoAllowed === null ? { state: "absent" } : { state: "present", value: demoAllowed };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("Status-bar prior read failed; recording an unobservable prior", error);
      return { state: "unobservable" };
    }
  }
}
