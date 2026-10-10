import type { AppearanceConfig, AppearanceConfigInput, AppearanceMode } from "../models";
import {
  createAppearanceConfigRepository,
  type KeyedConfigRepository,
} from "../db/keyedJsonConfigRepository";
import { parseAppearanceConfig } from "../features/appearance";
import { serverConfig } from "../utils/ServerConfig";
import { detectHostAppearance } from "../utils/hostAppearance";

const configRepository = createAppearanceConfigRepository();

/**
 * Appearance and sync config is per session (#10976): each session, an observer included, stores
 * its own row under its base session UUID. Without a session (direct mode, auth off) the single
 * global row is used, and it is also the fallback for a session that has stored nothing yet.
 */
const SESSION_ROW_PREFIX = "session:";

function rowKey(sessionKey?: string): string | undefined {
  return sessionKey ? `${SESSION_ROW_PREFIX}${sessionKey}` : undefined;
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

/**
 * Startup sweep (#11076): drop every per-session row whose session is not live. Rows are cleared
 * only by a live release or observer expiry, so a crash, a journal-terminalized UUID or a pruned
 * session row leaves them behind. Returns the session keys whose rows were dropped.
 */
export async function pruneSessionAppearanceConfigs(
  isLiveSession: (sessionKey: string) => boolean | Promise<boolean>,
  repository: KeyedConfigRepository<AppearanceConfig> = configRepository,
): Promise<string[]> {
  const dropped: string[] = [];
  for (const key of await repository.listKeys(SESSION_ROW_PREFIX)) {
    const sessionKey = key.slice(SESSION_ROW_PREFIX.length);
    // Decide per row, just before its delete, so a session admitted meanwhile keeps its row.
    if (!(await isLiveSession(sessionKey))) {
      await repository.clearConfig(key);
      dropped.push(sessionKey);
    }
  }
  return dropped;
}

export async function resolveAppearanceMode(config?: AppearanceConfig): Promise<AppearanceMode> {
  const resolvedConfig = config ?? (await getAppearanceConfig());
  if (resolvedConfig.syncWithHost || resolvedConfig.defaultMode === "auto") {
    return detectHostAppearance();
  }

  return resolvedConfig.defaultMode === "dark" ? "dark" : "light";
}
