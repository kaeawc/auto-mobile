import {
  CORESIMULATOR_DEVICE_SET_PATH_ENV,
  resolvePathFromDaemonLaunchWorkingDirectory,
} from "../workingDirectory";

/**
 * The env var name is unverified against a real toolchain. Explicit simctl
 * `--set` is the owner-approved fallback (#6900); a device check is still owed.
 */
export function customSimulatorDeviceSetPath(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment[CORESIMULATOR_DEVICE_SET_PATH_ENV]?.trim();
  return configured
    ? resolvePathFromDaemonLaunchWorkingDirectory(configured, environment)
    : undefined;
}

/** Arguments for xcrun, preserving caller argv exactly when no custom set is configured. */
export function buildSimctlArgs(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const deviceSetPath = customSimulatorDeviceSetPath(environment);
  return deviceSetPath ? ["simctl", "--set", deviceSetPath, ...args] : ["simctl", ...args];
}
