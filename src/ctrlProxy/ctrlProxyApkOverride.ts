import * as fs from "fs/promises";
import { ENV, readEnvRaw } from "../config/env";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";

/** The `stat` a CtrlProxy APK override check needs; tests inject a fake. */
export interface CtrlProxyApkOverrideProbe {
  stat(filePath: string): Promise<{ isFile(): boolean }>;
}

/**
 * Opens the override for reading and stats the open handle: a bare `stat` needs no read
 * permission, so an existing file the daemon cannot read (mode 000) would pass and fail later
 * at install.
 */
export const readableFileProbe: CtrlProxyApkOverrideProbe = {
  stat: async (filePath) => {
    const handle = await fs.open(filePath, "r");
    try {
      return await handle.stat();
    } finally {
      await handle.close();
    }
  },
};

const defaultProbe = readableFileProbe;

/** Absolute `AUTOMOBILE_CTRL_PROXY_APK_PATH`, resolved from the daemon launch cwd; null when unset or blank. */
export function resolveCtrlProxyApkPathOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const trimmed = readEnvRaw(ENV.CTRL_PROXY_APK_PATH, env)?.trim();
  return trimmed ? resolvePathFromDaemonLaunchWorkingDirectory(trimmed, env) : null;
}

/**
 * Fail with an actionable error naming the env var and path when the override
 * is missing or not a regular file (#18823), instead of a raw ENOENT.
 */
export async function assertCtrlProxyApkOverrideUsable(
  overridePath: string,
  probe: CtrlProxyApkOverrideProbe = defaultProbe,
): Promise<void> {
  const name = ENV.CTRL_PROXY_APK_PATH.name;
  let isFile: boolean;
  try {
    isFile = (await probe.stat(overridePath)).isFile();
  } catch (error) {
    throw new ActionableError(
      `${name} points to ${overridePath}, which cannot be read (${errorMessage(error)}). ` +
        `Build the CtrlProxy APK at that path, point ${name} at an existing APK, ` +
        `or unset ${name} and restart the daemon to use the release APK.`,
    );
  }
  if (!isFile) {
    throw new ActionableError(
      `${name} points to ${overridePath}, which is not a file. ` +
        `Point ${name} at a CtrlProxy APK, or unset it and restart the daemon to use the release APK.`,
    );
  }
}
