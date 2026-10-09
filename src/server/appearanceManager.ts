import type { AppearanceConfig, AppearanceConfigInput, AppearanceMode } from "../models";
import { createAppearanceConfigRepository } from "../db/keyedJsonConfigRepository";
import { parseAppearanceConfig } from "../features/appearance";
import { serverConfig } from "../utils/ServerConfig";
import { detectHostAppearance } from "../utils/hostAppearance";

const configRepository = createAppearanceConfigRepository();

/**
 * Appearance and sync config is per session (#10976): each session, an observer included, stores
 * its own row under its base session UUID. Without a session (direct mode, auth off) the single
 * global row is used, and it is also the fallback for a session that has stored nothing yet.
 */
function rowKey(sessionKey?: string): string | undefined {
  return sessionKey ? `session:${sessionKey}` : undefined;
}

function mergeConfigInput(
  defaults: AppearanceConfigInput,
  overrides: AppearanceConfigInput,
): AppearanceConfigInput {
  return {
    syncWithHost: overrides.syncWithHost ?? defaults.syncWithHost,
    defaultMode: overrides.defaultMode ?? defaults.defaultMode,
    applyOnConnect: overrides.applyOnConnect ?? defaults.applyOnConnect,
  };
}

function configToInput(config: AppearanceConfig): AppearanceConfigInput {
  return {
    syncWithHost: config.syncWithHost,
    defaultMode: config.defaultMode,
    applyOnConnect: config.applyOnConnect,
  };
}

export async function getAppearanceConfig(sessionKey?: string): Promise<AppearanceConfig> {
  const stored =
    (sessionKey ? await configRepository.getConfig(rowKey(sessionKey)) : null) ??
    (await configRepository.getConfig());
  if (stored) {
    return parseAppearanceConfig(stored);
  }
  return parseAppearanceConfig(serverConfig.getAppearanceDefaults());
}

export async function updateAppearanceConfig(
  update: AppearanceConfigInput | null,
  sessionKey?: string,
): Promise<AppearanceConfig> {
  if (update === null) {
    await configRepository.clearConfig(rowKey(sessionKey));
    const defaults = parseAppearanceConfig(serverConfig.getAppearanceDefaults());
    return defaults;
  }

  const current = await getAppearanceConfig(sessionKey);
  const mergedInput = mergeConfigInput(configToInput(current), update);
  const nextConfig = parseAppearanceConfig(mergedInput);
  await configRepository.setConfig(nextConfig, rowKey(sessionKey));
  return nextConfig;
}

/** Drops a session's stored config, e.g. when the session is released for good. */
export async function clearSessionAppearanceConfig(sessionKey: string): Promise<void> {
  await configRepository.clearConfig(rowKey(sessionKey));
}

export async function resolveAppearanceMode(config?: AppearanceConfig): Promise<AppearanceMode> {
  const resolvedConfig = config ?? (await getAppearanceConfig());
  if (resolvedConfig.syncWithHost || resolvedConfig.defaultMode === "auto") {
    return detectHostAppearance();
  }

  return resolvedConfig.defaultMode === "dark" ? "dark" : "light";
}
