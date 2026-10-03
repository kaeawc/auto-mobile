import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  CORESIMULATOR_DEVICE_SET_PATH_ENV,
  DAEMON_LAUNCH_CWD_ENV,
  normalizeCoreSimulatorDeviceSetPathEnv,
} from "../../src/utils/workingDirectory";

describe("normalizeCoreSimulatorDeviceSetPathEnv", () => {
  test("resolves a relative device-set path against the daemon launch directory", () => {
    const launchDirectory = resolve("launch-project");
    const env = {
      [CORESIMULATOR_DEVICE_SET_PATH_ENV]: "custom-devices",
      [DAEMON_LAUNCH_CWD_ENV]: launchDirectory,
    };

    normalizeCoreSimulatorDeviceSetPathEnv(env);

    expect(env[CORESIMULATOR_DEVICE_SET_PATH_ENV]).toBe(join(launchDirectory, "custom-devices"));
  });

  test("leaves an already-absolute device-set path untouched", () => {
    const absolutePath = resolve("/Volumes/CI/DeviceSets/job-7/Devices");
    const env = {
      [CORESIMULATOR_DEVICE_SET_PATH_ENV]: absolutePath,
      [DAEMON_LAUNCH_CWD_ENV]: resolve("launch-project"),
    };

    normalizeCoreSimulatorDeviceSetPathEnv(env);

    expect(env[CORESIMULATOR_DEVICE_SET_PATH_ENV]).toBe(absolutePath);
  });

  test("leaves a missing or blank device-set path untouched", () => {
    const missing: { [CORESIMULATOR_DEVICE_SET_PATH_ENV]?: string } = {};
    normalizeCoreSimulatorDeviceSetPathEnv(missing);
    expect(missing[CORESIMULATOR_DEVICE_SET_PATH_ENV]).toBeUndefined();

    const blank = { [CORESIMULATOR_DEVICE_SET_PATH_ENV]: "   " };
    normalizeCoreSimulatorDeviceSetPathEnv(blank);
    expect(blank[CORESIMULATOR_DEVICE_SET_PATH_ENV]).toBe("   ");
  });

  test("anchors a relative device set to the launch cwd carried by the injected env", () => {
    // The injected env supplies both the device-set path and launch directory.
    const injectedLaunch = resolve("/injected/launch/dir");
    const env = {
      [CORESIMULATOR_DEVICE_SET_PATH_ENV]: "custom-devices",
      [DAEMON_LAUNCH_CWD_ENV]: injectedLaunch,
    };

    normalizeCoreSimulatorDeviceSetPathEnv(env);

    expect(env[CORESIMULATOR_DEVICE_SET_PATH_ENV]).toBe(join(injectedLaunch, "custom-devices"));
  });

  test("normalizing before a chdir keeps a relative device set resolvable from any later cwd", () => {
    // Regression for issue #6582: SimCtlClient spawns `xcrun simctl` inheriting
    // `process.env` verbatim, so CoreSimulator would resolve a relative
    // CORESIMULATOR_DEVICE_SET_PATH against whatever the process's cwd happens
    // to be AFTER Daemon.start() chdirs to its stable working directory. The
    // direct TCC.db reader resolves the same raw value against the daemon
    // LAUNCH directory instead (via resolvePathFromDaemonLaunchWorkingDirectory).
    // Those two resolutions diverge unless the value is made absolute — and
    // therefore chdir-invariant — before anything reads it.
    const launchDirectory = resolve("launch-project");
    const env = {
      [CORESIMULATOR_DEVICE_SET_PATH_ENV]: "custom-devices",
      [DAEMON_LAUNCH_CWD_ENV]: launchDirectory,
    };
    normalizeCoreSimulatorDeviceSetPathEnv(env);
    const resolvedForEveryConsumer = env[CORESIMULATOR_DEVICE_SET_PATH_ENV];

    // Simulate reads from two different "current working directories" after a
    // daemon chdir — an already-absolute value ignores cwd entirely, so both
    // reads see the identical directory.
    expect(resolve("/unrelated/post-chdir/cwd", resolvedForEveryConsumer)).toBe(
      resolvedForEveryConsumer,
    );
    expect(resolve(launchDirectory, resolvedForEveryConsumer)).toBe(resolvedForEveryConsumer);
  });
});
