import type { BootedDevice } from "../../../models";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ProcessExecutor } from "../../../utils/ProcessExecutor";
import type { SystemConfigurationAdapter } from "../../../utils/interfaces/SystemConfigurationAdapter";
import { AndroidSystemConfigurationAdapter } from "./AndroidSystemConfigurationAdapter";
import { IosSystemConfigurationAdapter } from "./IosSystemConfigurationAdapter";
import type { LockdownLocaleClient } from "./IosLockdownLocaleClient";

/**
 * Build the platform-appropriate {@link SystemConfigurationAdapter}
 * for `device`. Centralising the selection here keeps
 * `SystemConfigurationManager.ts` free of platform branches.
 */
export function createSystemConfigurationAdapter(
  device: BootedDevice,
  adb: AdbExecutor,
  processExecutor: ProcessExecutor,
  lockdownLocaleClient?: LockdownLocaleClient
): SystemConfigurationAdapter {
  if (device.platform === "ios") {
    return new IosSystemConfigurationAdapter(device, processExecutor, lockdownLocaleClient);
  }
  return new AndroidSystemConfigurationAdapter(device, adb);
}
