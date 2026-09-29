import type { AdbClientFactory } from "./AdbClientFactory";
import { defaultAdbClientFactory } from "./AdbClientFactory";
import { defaultTimer, type Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";

export const MANAGED_ADB_SERVER_ENV = "AUTOMOBILE_MANAGED_ADB_SERVER";
export const LEGACY_MANAGED_ADB_SERVER_ENV = "AUTO_MOBILE_MANAGED_ADB_SERVER";
export const MANAGED_ADB_SERVER_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface ManagedAdbServerShutdownDependencies {
  readonly adbFactory?: AdbClientFactory;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timer?: Timer;
  readonly shutdownTimeoutMs?: number;
}

/**
 * Managed mode is an explicit process-scope ownership claim. It is off by
 * default so that routine client shutdowns never stop a shared local server.
 */
export function isManagedAdbServerEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment[MANAGED_ADB_SERVER_ENV] ?? environment[LEGACY_MANAGED_ADB_SERVER_ENV];
  return value?.trim().toLowerCase() === "1" || value?.trim().toLowerCase() === "true";
}

export async function stopManagedAdbServer(
  dependencies: ManagedAdbServerShutdownDependencies = {},
): Promise<void> {
  const environment = dependencies.environment ?? process.env;
  if (!isManagedAdbServerEnabled(environment)) {
    return;
  }

  const timeoutMs = dependencies.shutdownTimeoutMs ?? MANAGED_ADB_SERVER_SHUTDOWN_TIMEOUT_MS;
  const timer = dependencies.timer ?? defaultTimer;
  const controller = new AbortController();
  const adb = (dependencies.adbFactory ?? defaultAdbClientFactory).create();
  const timeoutMessage = `Managed ADB server shutdown timed out after ${timeoutMs}ms`;
  await raceWithDeadline(
    adb.execute(["kill-server"], {
      timeoutMs,
      noRetry: true,
      signal: controller.signal,
    }),
    {
      timer,
      timeoutMs,
      label: "Managed ADB server shutdown",
      timeoutError: () => new Error(timeoutMessage),
      onTimeout: () => controller.abort(new Error(timeoutMessage)),
    },
  );
}
