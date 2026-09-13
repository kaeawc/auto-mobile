import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DAEMON_LAUNCH_CWD_ENV = "AUTOMOBILE_DAEMON_LAUNCH_CWD";

export function safeProcessCwd(fallback: string = "/"): string {
  try {
    return process.cwd();
  } catch {
    return fallback;
  }
}

export function resolveStableDaemonWorkingDirectory(homeDirectory: string = homedir()): string {
  if (homeDirectory.length > 0 && existsSync(homeDirectory)) {
    return homeDirectory;
  }

  return "/";
}

export function resolveDaemonLaunchWorkingDirectory(
  currentWorkingDirectory: string = safeProcessCwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const launchCwd = env[DAEMON_LAUNCH_CWD_ENV]?.trim();
  return launchCwd && path.isAbsolute(launchCwd) ? launchCwd : currentWorkingDirectory;
}

export function resolvePathFromDaemonLaunchWorkingDirectory(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(resolveDaemonLaunchWorkingDirectory(undefined, env), filePath);
}

/**
 * Rewrites a RELATIVE `CORESIMULATOR_DEVICE_SET_PATH` on the given env map to
 * an absolute path anchored at the daemon launch directory, in place.
 *
 * Must run before `Daemon.start()` calls `process.chdir()`. Two independent
 * consumers read this variable after startup: `SimCtlClient` (which spawns
 * `xcrun simctl` inheriting `process.env` as-is, so CoreSimulator resolves any
 * relative value against the process's CURRENT — post-chdir — working
 * directory) and `SimulatorTccSqliteClient` (which falls back to reading this
 * same variable and resolves a relative value via
 * `resolvePathFromDaemonLaunchWorkingDirectory`, i.e. against the daemon LAUNCH
 * directory). Left un-normalized, a relative device-set path makes the two
 * consumers target different directories after the daemon chdirs (issue
 * #6582). Normalizing to an absolute path here — before either consumer or the
 * chdir runs — makes both resolve the identical directory regardless of the
 * daemon's current working directory at read time.
 */
export function normalizeCoreSimulatorDeviceSetPathEnv(env: NodeJS.ProcessEnv = process.env): void {
  const deviceSetPath = env.CORESIMULATOR_DEVICE_SET_PATH?.trim();
  if (deviceSetPath) {
    // Resolve the anchor against the SAME env the path came from, so an injected
    // env is the single source of truth for both the path and its launch cwd.
    env.CORESIMULATOR_DEVICE_SET_PATH = resolvePathFromDaemonLaunchWorkingDirectory(
      deviceSetPath,
      env,
    );
  }
}
