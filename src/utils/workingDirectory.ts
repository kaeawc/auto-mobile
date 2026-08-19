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

export function resolveStableDaemonWorkingDirectory(
  homeDirectory: string = homedir()
): string {
  if (homeDirectory.length > 0 && existsSync(homeDirectory)) {
    return homeDirectory;
  }

  return "/";
}

export function resolveDaemonLaunchWorkingDirectory(
  currentWorkingDirectory: string = safeProcessCwd(),
  env: NodeJS.ProcessEnv = process.env
): string {
  const launchCwd = env[DAEMON_LAUNCH_CWD_ENV]?.trim();
  return launchCwd && path.isAbsolute(launchCwd)
    ? launchCwd
    : currentWorkingDirectory;
}

export function resolvePathFromDaemonLaunchWorkingDirectory(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(resolveDaemonLaunchWorkingDirectory(), filePath);
}
