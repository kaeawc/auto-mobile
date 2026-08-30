/**
 * Auto-mobile working directory utilities.
 *
 * Provides consistent, secure working directory creation with restrictive
 * permissions. The base resolves to a STABLE, non-ephemeral location so that
 * long-lived state (daemon logs, persistent caches) survives package-runner
 * temp-dir cleanup. When AutoMobile is launched via `bunx`, `os.tmpdir()` can
 * point into an extraction tree that bunx later reaps while the daemon still
 * holds open file descriptors — leaving on-disk logs at 0 bytes and cache
 * writes failing with ENOENT (issue #2724). Anchoring on the user's home dir
 * (`~/.auto-mobile`) avoids that lifecycle entirely.
 */

import fs from "node:fs";
import os from "os";
import path from "path";
import { toActionableError } from "../models/ActionableError";
import { resolveDaemonLaunchWorkingDirectory } from "./workingDirectory";

/**
 * Restrictive directory permissions (owner read/write/execute only).
 * Prevents other users from accessing auto-mobile files.
 */
const SECURE_DIR_MODE = 0o700;

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
 * @param daemonLaunchWorkingDirectory - Directory used to resolve relative overrides
 * @returns Absolute path to the auto-mobile base directory
 */
export function resolveAutoMobileBaseDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  daemonLaunchWorkingDirectory: string = resolveDaemonLaunchWorkingDirectory(undefined, env),
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
 * A log-dir override intentionally takes precedence over the data-dir-derived
 * logs child without changing the base directory for any other AutoMobile
 * state. Relative overrides are anchored to the daemon launch directory so a
 * manager and its spawned daemon agree even after the daemon changes cwd.
 */
export function resolveAutoMobileLogsDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  daemonLaunchWorkingDirectory: string = resolveDaemonLaunchWorkingDirectory(undefined, env),
): string {
  const override = (env.AUTOMOBILE_LOG_DIR ?? env.AUTO_MOBILE_LOG_DIR)?.trim();
  if (override && override.length > 0) {
    return path.resolve(daemonLaunchWorkingDirectory, override);
  }

  return path.join(
    resolveAutoMobileBaseDir(env, homeDir, daemonLaunchWorkingDirectory),
    TEMP_SUBDIRS.LOGS,
  );
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

/**
 * Resolve a secure coordination directory shared by all agents for this user.
 *
 * Unlike {@link getTempDir}, this deliberately ignores `AUTOMOBILE_DATA_DIR`
 * because those overrides isolate an agent's private state. Processes using
 * the same default ADB server must instead coordinate through one path. A
 * locked-down service account can configure that path with
 * `AUTOMOBILE_COORDINATION_DIR` (or `AUTO_MOBILE_COORDINATION_DIR`).
 */
export function getSharedAutoMobileDir(
  subdirectory: string,
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = (env.AUTOMOBILE_COORDINATION_DIR ?? env.AUTO_MOBILE_COORDINATION_DIR)?.trim();
  if (override && override.length > 0) {
    if (!path.isAbsolute(override)) {
      throw new Error(
        "AUTOMOBILE_COORDINATION_DIR must be an absolute path so all agents share one coordination directory.",
      );
    }
    return path.join(override, subdirectory);
  }
  if (homeDir.length === 0) {
    throw new Error(
      "Unable to resolve a shared AutoMobile directory without a home directory. Set AUTOMOBILE_COORDINATION_DIR to a writable shared directory.",
    );
  }
  return path.join(path.resolve(homeDir), ".auto-mobile", subdirectory);
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
 * Synchronously ensure an agent-invariant coordination directory exists.
 */
export function ensureSecureSharedAutoMobileDirSync(subdirectory: string): string {
  return ensureSecureDirectorySync(getSharedAutoMobileDir(subdirectory));
}

/**
 * Synchronously ensure the shared log directory exists with restrictive permissions.
 */
export function ensureSecureLogsDirSync(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  try {
    return ensureSecureDirectorySync(resolveAutoMobileLogsDir(env, homeDir));
  } catch (error) {
    if (error instanceof Error && error.message.includes("symbolic-link directory")) {
      throw toActionableError(error, "Refusing to use symbolic-link directory for AutoMobile logs");
    }
    throw toActionableError(
      error,
      "Unable to initialize the AutoMobile log directory. Set AUTOMOBILE_LOG_DIR to a writable directory.",
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
