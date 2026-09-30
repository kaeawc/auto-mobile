import type { AppearanceMode, BootedDevice } from "../models";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultAdbClientFactory } from "./android-cmdline-tools/AdbClientFactory";
import { resolveAndroidSdkRoot } from "./android-cmdline-tools/androidSdkRoot";
import { SimCtlClient } from "./ios-cmdline-tools/SimCtlClient";
import { logger } from "./logger";

export async function applyAppearanceToDevice(
  device: BootedDevice,
  mode: AppearanceMode,
): Promise<void> {
  if (device.platform === "android") {
    const adbName = process.platform === "win32" ? "adb.exe" : "adb";
    const sdkRoot = resolveAndroidSdkRoot(process.env, (candidate) =>
      existsSync(join(candidate, "platform-tools", adbName)),
    );
    if (!sdkRoot) {
      logger.debug(
        "Skipping Android host appearance sync because configured SDK adb was not found",
      );
      return;
    }
    const adb = defaultAdbClientFactory.create(device);
    const setting = mode === "dark" ? "yes" : "no";
    await adb.executeCommand(`shell cmd uimode night ${setting}`);
    logger.info(`[Appearance] Set Android appearance to ${mode} for ${device.deviceId}`);
    return;
  }

  if (device.platform === "ios") {
    const simctl = new SimCtlClient(device);
    await simctl.setAppearance(mode);
    logger.info(`[Appearance] Set iOS appearance to ${mode} for ${device.deviceId}`);
  }
}
