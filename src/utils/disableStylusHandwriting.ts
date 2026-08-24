import type { BootedDevice } from "../models";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "./android-cmdline-tools/AdbClientFactory";
import { logger } from "./logger";

export async function disableStylusHandwriting(
  device: BootedDevice,
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
): Promise<void> {
  if (device.platform !== "android") {
    return;
  }

  if (!device.deviceId.startsWith("emulator-")) {
    return;
  }

  try {
    const adb = adbFactory.create(device);
    await adb.executeCommand("shell settings put secure stylus_handwriting_enabled 0");
    logger.info(`[StylusHandwriting] Disabled stylus handwriting on ${device.deviceId}`);
  } catch (error) {
    logger.warn(
      `[StylusHandwriting] Failed to disable stylus handwriting on ${device.deviceId}: ${error}`,
    );
  }
}
