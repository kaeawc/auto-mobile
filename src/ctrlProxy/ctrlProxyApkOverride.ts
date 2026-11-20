import * as fs from "fs/promises";
import { ENV, readEnvRaw } from "../config/env";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";

/** Reads the override's file type; it throws when the path cannot be opened for reading. */
export type ApkOverrideStat = (path: string) => Promise<{ isFile(): boolean }>;

/**
 * Opens the override for reading and stats the open handle, so an existing file the daemon cannot
 * read (mode 000) is refused like a missing one; a bare `stat` needs no read permission.
 */
export const statReadableFile: ApkOverrideStat = async (path) => {
  const handle = await fs.open(path, "r");
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
};

/**
 * The `AUTOMOBILE_CTRL_PROXY_APK_PATH` override as an absolute path (relative values resolve
 * against the daemon launch directory), or null when unset or blank.
 */
export function resolveCtrlProxyApkPathOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const trimmed = readEnvRaw(ENV.CTRL_PROXY_APK_PATH, env)?.trim();
  return trimmed ? resolvePathFromDaemonLaunchWorkingDirectory(trimmed, env) : null;
}

/** The override names a path that is missing, unreadable or not a regular file (#18823). */
export class CtrlProxyApkOverrideUnusableError extends ActionableError {
  constructor(
    readonly overridePath: string,
    reason: string,
    consequence: string,
    options?: ErrorOptions,
  ) {
    super(
      `${ENV.CTRL_PROXY_APK_PATH.name} points at ${overridePath}, which ${reason}. ${consequence} ` +
        `Build the CtrlProxy APK at that path, point ${ENV.CTRL_PROXY_APK_PATH.name} at an existing ` +
        "APK, or unset it and restart the daemon to use the release APK.",
      options,
    );
    this.name = "CtrlProxyApkOverrideUnusableError";
  }
}

/**
 * Throws {@link CtrlProxyApkOverrideUnusableError} when `overridePath` cannot be installed from.
 * `consequence` tells the caller what did not happen (e.g. that no device was booted).
 */
export async function assertCtrlProxyApkOverrideUsable(
  overridePath: string,
  stat: ApkOverrideStat,
  consequence: string,
): Promise<void> {
  let isFile: boolean;
  try {
    isFile = (await stat(overridePath)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const reason = code === "ENOENT" ? "does not exist" : `cannot be read (${errorMessage(error)})`;
    throw new CtrlProxyApkOverrideUnusableError(overridePath, reason, consequence, {
      cause: error,
    });
  }
  if (!isFile) {
    throw new CtrlProxyApkOverrideUnusableError(overridePath, "is not a file", consequence);
  }
}

/**
 * Before an Android acquisition boots or adopts a device: refuse a set override whose file is
 * unusable, so a stale path fails with nothing booted instead of at runner readiness (#18823).
 */
export async function preflightCtrlProxyApkOverride(
  env: NodeJS.ProcessEnv,
  stat: ApkOverrideStat,
): Promise<void> {
  const overridePath = resolveCtrlProxyApkPathOverride(env);
  if (overridePath !== null) {
    await assertCtrlProxyApkOverrideUsable(overridePath, stat, "No device was booted.");
  }
}
