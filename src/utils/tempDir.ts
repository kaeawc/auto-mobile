/**
 * Auto-mobile working directory utilities.
 *
 * Provides consistent, secure working directory creation with restrictive
 * permissions. The base resolves to a STABLE, non-ephemeral location so that
 * long-lived non-log state (persistent caches) survives package-runner temp-dir
 * cleanup. When AutoMobile is launched via `bunx`, `os.tmpdir()` can point into
 * an extraction tree that bunx later reaps while the daemon still holds open
 * file descriptors, so persistent state is anchored on the user's home dir
 * (`~/.auto-mobile`).
 */

import fs from "node:fs";
import os from "os";
import path from "path";
import { ActionableError } from "../models/ActionableError";
import { resolveDaemonLaunchWorkingDirectory } from "./workingDirectory";

/**
 * Restrictive directory permissions (owner read/write/execute only).
 * Prevents other users from accessing auto-mobile files.
 */
const SECURE_DIR_MODE = 0o700;

function defaultAutoMobileLogsDir(homeDir: string, daemonLaunchWorkingDirectory: string): string {
  if (homeDir && homeDir.length > 0) {
    return path.resolve(daemonLaunchWorkingDirectory, homeDir, ".auto-mobile", "logs");
  }

  const userId = process.platform === "win32"
    ? os.userInfo().username || "default"
    : process.getuid?.()?.toString() || "default";
  const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
  return path.join(temporaryRoot, `auto-mobile-${userId}`);
}

function resolveAutoMobileLogsDirOverride(env: NodeJS.ProcessEnv): string | undefined {
  const override = (env.AUTOMOBILE_LOG_DIR ?? env.AUTO_MOBILE_LOG_DIR)?.trim();
  return override && override.length > 0 ? override : undefined;
}

/**
 * Resolve the stable base directory for AutoMobile's non-log on-disk state.
 *
 * Resolution order:
 * 1. `AUTOMOBILE_DATA_DIR` / `AUTO_MOBILE_DATA_DIR` — explicit, configurable
 *    override (also the per-agent isolation knob on shared hosts). Resolved to
 *    an absolute path.
 * 2. `~/.auto-mobile` — stable, per-user default. Matches the existing
 *    `.auto-mobile` convention used for daemon sockets, and is never reaped by
 *    a package runner's temp-dir cleanup.
 * 3. `os.tmpdir()/auto-mobile` — last-resort fallback for locked-down
 *    environments where no home directory is resolvable.
 *
 * Deliberately does NOT derive the base from `TMPDIR`/`TMP`/`TEMP`: bunx may set
 * those to an ephemeral extraction dir, which is the root cause of issue #2724.
 *
 * @param env - Environment to read overrides from (injectable for tests)
 * @param homeDir - Home directory to anchor the default on (injectable for tests)
 * @returns Absolute path to the auto-mobile base directory
 */
export function resolveAutoMobileBaseDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  daemonLaunchWorkingDirectory: string = resolveDaemonLaunchWorkingDirectory(undefined, env)
): string {
  const override = (env.AUTOMOBILE_DATA_DIR ?? env.AUTO_MOBILE_DATA_DIR)?.trim();
  if (override && override.length > 0) {
    return path.resolve(daemonLaunchWorkingDirectory, override);
  }

  if (homeDir && homeDir.length > 0) {
    return path.resolve(daemonLaunchWorkingDirectory, homeDir, ".auto-mobile");
  }

  return path.join(os.tmpdir(), "auto-mobile");
}

/**
 * Resolve the directory for structured and daemon-launch logs.
 *
 * A log-dir override intentionally takes precedence over the default without
 * changing the base directory for any other AutoMobile state. Without an
 * override, logs use the owner-controlled `~/.auto-mobile/logs` directory.
 * If that directory cannot be initialized and `AUTOMOBILE_DATA_DIR` is set,
 * initialization falls back to `<data-dir>/logs`. This avoids both
 * package-runner temporary-directory cleanup and a predictable directory entry
 * in a shared system temporary root. Relative overrides are anchored to the
 * daemon launch directory so a manager and its spawned daemon agree even after
 * the daemon changes cwd.
 */
export function resolveAutoMobileLogsDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  daemonLaunchWorkingDirectory: string = resolveDaemonLaunchWorkingDirectory(undefined, env)
): string {
  const override = resolveAutoMobileLogsDirOverride(env);
  if (override) {
    return path.resolve(daemonLaunchWorkingDirectory, override);
  }

  return defaultAutoMobileLogsDir(homeDir, daemonLaunchWorkingDirectory);
}

/**
 * Get a secure auto-mobile directory path for a given subdirectory.
 * Does NOT create the directory - use ensureSecureTempDirSync for that.
 *
 * Resolved lazily on each call so an `AUTOMOBILE_DATA_DIR` override set after
 * module load (and tests) is honored.
 *
 * @param subdirectory - Subdirectory name under the auto-mobile base
 * @returns Full path to the directory
 */
export function getTempDir(subdirectory: string): string {
  return path.join(resolveAutoMobileBaseDir(), subdirectory);
}

function ensureSecureDirectorySync(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error(`Refusing to use symbolic-link directory: ${dir}`);
  }
  if (process.platform !== "win32") {
    fs.chmodSync(dir, SECURE_DIR_MODE);
  }
  return dir;
}

/**
 * Synchronously ensure a secure temp directory exists with restrictive permissions.
 *
 * @param subdirectory - Subdirectory name under auto-mobile temp base
 * @returns Full path to the created/existing temp directory
 */
export function ensureSecureTempDirSync(subdirectory: string): string {
  return ensureSecureDirectorySync(getTempDir(subdirectory));
}

/**
 * Synchronously ensure the shared log directory exists with restrictive permissions.
 */
export function ensureSecureLogsDirSync(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir()
): string {
  try {
    const daemonLaunchWorkingDirectory = resolveDaemonLaunchWorkingDirectory(undefined, env);
    const logsDir = resolveAutoMobileLogsDir(env, homeDir, daemonLaunchWorkingDirectory);
    try {
      return ensureSecureDirectorySync(logsDir);
    } catch (error) {
      if (resolveAutoMobileLogsDirOverride(env)) {
        throw error;
      }

      const dataDirLogs = path.join(
        resolveAutoMobileBaseDir(env, homeDir, daemonLaunchWorkingDirectory),
        "logs"
      );
      if (dataDirLogs === logsDir) {
        throw error;
      }
      return ensureSecureDirectorySync(dataDirLogs);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("symbolic-link directory")) {
      throw new ActionableError(
        "Refusing to use symbolic-link directory for AutoMobile logs",
        { cause: error }
      );
    }
    throw new ActionableError(
      "Unable to initialize the AutoMobile log directory. Set AUTOMOBILE_LOG_DIR to a writable directory.",
      { cause: error }
    );
  }
}

// Common subdirectory constants for consistency
export const TEMP_SUBDIRS = {
  LOGS: "logs",
  TOOL_LOGS: "tool_logs",
  SCREENSHOTS: "screenshots",
  NAVIGATION_SCREENSHOTS: "navigation-screenshots",
  VIEW_HIERARCHY: "view_hierarchy",
  OBSERVE_RESULTS: "observe_results",
  TOOL_OUTPUTS: "tool_outputs",
  WINDOW: "window",
  CACHE: "cache",
  STATE: "state",
} as const;
