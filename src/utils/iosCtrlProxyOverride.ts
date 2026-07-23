import { promises as fs, statSync } from "fs";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "./workingDirectory";
import { logger } from "./logger";

/**
 * Reader for the local iOS CtrlProxy runner override
 * (AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH / AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH).
 *
 * Both are aliases for a packaged `.ipa` file; IPA_PATH wins when both are set.
 * Centralised here because three call sites read these vars with subtly
 * different logic, and #4221 needs one consistent answer to "is this override
 * present, and is it actually usable?".
 */

/** The raw override string as set, IPA_PATH preferred, trimmed; null if unset. */
export function getIosCtrlProxyOverrideRaw(env: NodeJS.ProcessEnv = process.env): string | null {
  const ipaPath = env.AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH?.trim();
  const bundlePath = env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH?.trim();
  const value = (ipaPath && ipaPath.length > 0 ? ipaPath : undefined)
    ?? (bundlePath && bundlePath.length > 0 ? bundlePath : undefined);
  return value ?? null;
}

/** True when either override env var is set to a non-empty value. */
export function hasIosCtrlProxyOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  return getIosCtrlProxyOverrideRaw(env) !== null;
}

/** The override resolved against the daemon launch cwd; null if unset. */
export function getIosCtrlProxyOverridePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = getIosCtrlProxyOverrideRaw(env);
  return raw === null ? null : resolvePathFromDaemonLaunchWorkingDirectory(raw);
}

export interface IosCtrlProxyOverrideCheck {
  /** True when an override env var is set at all. */
  present: boolean;
  /** True when it resolves to a real file (the packaged .ipa the loader needs). */
  usable: boolean;
  /** The resolved path, or null when no override is set. */
  path: string | null;
  /** A human-readable reason when present but not usable. */
  reason?: string;
}

/**
 * Resolve and validate the override.
 *
 * `usable` is true only when the override points at a real file. A directory
 * (the common mistake -- pointing at a local `Build/Products` derived-data tree)
 * is `present: true, usable: false`, so callers can fail closed with an
 * actionable message instead of silently running the released runner (#4221).
 */
export async function checkIosCtrlProxyOverride(
  env: NodeJS.ProcessEnv = process.env
): Promise<IosCtrlProxyOverrideCheck> {
  const path = getIosCtrlProxyOverridePath(env);
  if (path === null) {
    return { present: false, usable: false, path: null };
  }

  try {
    const stats = await fs.stat(path);
    if (stats.isFile()) {
      return { present: true, usable: true, path };
    }
    return {
      present: true,
      usable: false,
      path,
      reason: `expected an .ipa file but ${path} is a directory. For a local xcodebuild `
        + `output, set AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA to the derived-data root instead.`
    };
  } catch (error) {
    // A missing path is the expected "override set but unusable" case, not a
    // failure of this check; log at debug so there is a trace without noise.
    logger.debug(`[iosCtrlProxyOverride] override path not statable: ${path} (${error})`);
    return {
      present: true,
      usable: false,
      path,
      reason: `path does not exist: ${path}`
    };
  }
}

/**
 * Synchronous "is the override usable?" for callers on a sync path (the network
 * error-simulation capability guard). Same file-vs-directory rule as
 * {@link checkIosCtrlProxyOverride}.
 */
export function isIosCtrlProxyOverrideUsableSync(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = getIosCtrlProxyOverridePath(env);
  if (path === null) {
    return false;
  }
  try {
    return statSync(path).isFile();
  } catch (error) {
    // Missing/unstatable path is simply "not usable"; a debug trace suffices.
    logger.debug(`[iosCtrlProxyOverride] override path not statable (sync): ${path} (${error})`);
    return false;
  }
}
