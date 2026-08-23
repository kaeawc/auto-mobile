import type { BootedDevice } from "../../../models";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { HostCommandExecutor } from "../../../utils/HostCommandExecutor";
import type { SystemConfigurationAdapter } from "../../../utils/interfaces/SystemConfigurationAdapter";
import { AndroidSystemConfigurationAdapter } from "./AndroidSystemConfigurationAdapter";
import { IosSystemConfigurationAdapter } from "./IosSystemConfigurationAdapter";

/**
 * Build the platform-appropriate {@link SystemConfigurationAdapter}
 * for `device`. Centralising the selection here keeps
 * `SystemConfigurationManager.ts` free of platform branches.
 */
export function createSystemConfigurationAdapter(
  device: BootedDevice,
  adb: AdbExecutor,
  processExecutor: HostCommandExecutor,
): SystemConfigurationAdapter {
  if (device.platform === "ios") {
    return new IosSystemConfigurationAdapter(device, processExecutor);
  }
  return new AndroidSystemConfigurationAdapter(device, adb);
}
