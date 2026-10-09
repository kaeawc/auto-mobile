import type { AppearanceMode, BootedDevice } from "../models";
import { getAppearanceConfig, resolveAppearanceMode } from "./appearanceManager";
import { applyAppearanceToDevice } from "../utils/deviceAppearance";
import { logger } from "../utils/logger";
import { isAppearanceSyncEnabledFromEnvironment } from "../utils/appearance/appearanceSyncPolicy";

export interface AppearanceOnConnectDependencies {
  isSyncEnabled: () => boolean;
  getConfig: typeof getAppearanceConfig;
  resolveMode: typeof resolveAppearanceMode;
  apply: typeof applyAppearanceToDevice;
}

const defaultDependencies: AppearanceOnConnectDependencies = {
  isSyncEnabled: isAppearanceSyncEnabledFromEnvironment,
  getConfig: getAppearanceConfig,
  resolveMode: resolveAppearanceMode,
  apply: applyAppearanceToDevice,
};

export async function applyAppearanceOnConnect(
  device: BootedDevice,
  dependencies: Partial<AppearanceOnConnectDependencies> = {},
  /** Base UUID of the connecting session: only its own config applies (#10976). */
  sessionKey?: string,
): Promise<AppearanceMode | null> {
  const { isSyncEnabled, getConfig, resolveMode, apply } = {
    ...defaultDependencies,
    ...dependencies,
  };
  if (!isSyncEnabled()) {
    return null;
  }
  try {
    const config = await getConfig(sessionKey);
    if (!config.applyOnConnect) {
      return null;
    }

    const mode = await resolveMode(config);
    if (!isSyncEnabled()) {
      return null;
    }
    await apply(device, mode);
    return mode;
  } catch (error) {
    logger.warn("[Appearance] Failed to apply appearance on connect", error);
    return null;
  }
}
