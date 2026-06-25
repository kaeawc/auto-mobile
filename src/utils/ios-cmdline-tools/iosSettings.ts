import type { SimCtlClient } from "./SimCtlClient";
import { quoteSimctlArg } from "./iosAppContainer";
import { logger } from "../logger";

/**
 * Curated (domain, key) allowlist captured/restored for iOS simulator snapshots.
 *
 * Deliberately NOT a full plist clone — a curated allowlist keeps restore robust
 * across OS versions and surgical (per-key `defaults write`, never whole-domain
 * `defaults import`, so system-managed keys are never clobbered).
 *
 * Restricted to **scalar string** keys for this cut: `defaults read AppleLanguages`
 * returns array-shaped output that a plain per-key `defaults write` cannot
 * round-trip without an array type flag, so array-typed keys are a follow-up.
 */
export const IOS_SETTINGS_KEYS: ReadonlyArray<{ domain: string; key: string }> = [
  { domain: ".GlobalPreferences", key: "AppleLocale" },
] as const;

export interface IosSettingsSnapshot {
  /** "domain/key" -> raw `defaults read` stdout value (scalar). */
  values: Record<string, string>;
  /** device-level UI state restorable via `simctl ui`. */
  ui?: { appearance?: "light" | "dark"; contentSize?: string };
}

/**
 * Read current device-level UI state. `simctl ui <udid> appearance` with no value
 * prints the current setting; `content_size` is read the same way.
 */
async function captureUiState(
  simctl: Pick<SimCtlClient, "executeCommand">,
  deviceId: string
): Promise<IosSettingsSnapshot["ui"]> {
  const ui: NonNullable<IosSettingsSnapshot["ui"]> = {};
  try {
    const appearance = (
      await simctl.executeCommand(`ui ${quoteSimctlArg(deviceId)} appearance`)
    ).stdout.trim();
    if (appearance === "light" || appearance === "dark") {
      ui.appearance = appearance;
    }
  } catch (error) {
    logger.warn(`[iOS] Failed to read appearance: ${error}`);
  }
  try {
    const contentSize = (
      await simctl.executeCommand(`ui ${quoteSimctlArg(deviceId)} content_size`)
    ).stdout.trim();
    if (contentSize) {
      ui.contentSize = contentSize;
    }
  } catch (error) {
    logger.warn(`[iOS] Failed to read content_size: ${error}`);
  }
  return Object.keys(ui).length > 0 ? ui : undefined;
}

/** Capture the curated iOS settings allowlist + device-level UI state. */
export async function captureIosSettings(
  simctl: Pick<SimCtlClient, "executeCommand">,
  deviceId: string
): Promise<IosSettingsSnapshot> {
  const values: Record<string, string> = {};
  for (const { domain, key } of IOS_SETTINGS_KEYS) {
    try {
      const cmd =
        `spawn ${quoteSimctlArg(deviceId)} defaults read ` +
        `${quoteSimctlArg(domain)} ${quoteSimctlArg(key)}`;
      const result = await simctl.executeCommand(cmd);
      const value = result.stdout.trim();
      if (value) {
        values[`${domain}/${key}`] = value;
      }
    } catch (error) {
      // An unset key makes `defaults read` exit non-zero — expected, non-fatal.
      logger.debug(`[iOS] No value for ${domain}/${key}: ${error}`);
    }
  }
  return { values, ui: await captureUiState(simctl, deviceId) };
}

/**
 * Restore captured iOS settings. Per-key `defaults write` (surgical, idempotent,
 * does NOT replace the whole domain) followed by device-level `simctl ui` so
 * appearance/content size take effect without a respawn. Individual key failures
 * are logged and skipped (non-fatal).
 */
export async function restoreIosSettings(
  simctl: Pick<SimCtlClient, "executeCommand">,
  deviceId: string,
  settings: IosSettingsSnapshot
): Promise<void> {
  for (const [compoundKey, value] of Object.entries(settings.values)) {
    const slash = compoundKey.indexOf("/");
    if (slash < 0) {
      continue;
    }
    const domain = compoundKey.slice(0, slash);
    const key = compoundKey.slice(slash + 1);
    try {
      const cmd =
        `spawn ${quoteSimctlArg(deviceId)} defaults write ` +
        `${quoteSimctlArg(domain)} ${quoteSimctlArg(key)} ${quoteSimctlArg(value)}`;
      await simctl.executeCommand(cmd);
    } catch (error) {
      logger.warn(`[iOS] Failed to write ${domain}/${key}: ${error}`);
    }
  }

  if (settings.ui?.appearance) {
    try {
      await simctl.executeCommand(
        `ui ${quoteSimctlArg(deviceId)} appearance ${settings.ui.appearance}`
      );
    } catch (error) {
      logger.warn(`[iOS] Failed to restore appearance: ${error}`);
    }
  }
  if (settings.ui?.contentSize) {
    try {
      await simctl.executeCommand(
        `ui ${quoteSimctlArg(deviceId)} content_size ${quoteSimctlArg(settings.ui.contentSize)}`
      );
    } catch (error) {
      logger.warn(`[iOS] Failed to restore content_size: ${error}`);
    }
  }
}
