import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  DAEMON_LAUNCH_CWD_ENV,
  normalizeCoreSimulatorDeviceSetPathEnv,
} from "../../src/utils/workingDirectory";

function withDaemonLaunchCwd<T>(launchDirectory: string, run: () => T): T {
  const previous = process.env[DAEMON_LAUNCH_CWD_ENV];
  process.env[DAEMON_LAUNCH_CWD_ENV] = launchDirectory;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = previous;
    }
  }
}

describe("normalizeCoreSimulatorDeviceSetPathEnv", () => {
  test("resolves a relative CORESIMULATOR_DEVICE_SET_PATH against the daemon launch directory", () => {
    const launchDirectory = resolve("launch-project");
    withDaemonLaunchCwd(launchDirectory, () => {
      const env = { CORESIMULATOR_DEVICE_SET_PATH: "custom-devices" };

      normalizeCoreSimulatorDeviceSetPathEnv(env);

      expect(env.CORESIMULATOR_DEVICE_SET_PATH).toBe(join(launchDirectory, "custom-devices"));
    });
  });

  test("leaves an already-absolute CORESIMULATOR_DEVICE_SET_PATH untouched", () => {
    const absolutePath = resolve("/Volumes/CI/DeviceSets/job-7/Devices");
    withDaemonLaunchCwd(resolve("launch-project"), () => {
      const env = { CORESIMULATOR_DEVICE_SET_PATH: absolutePath };

      normalizeCoreSimulatorDeviceSetPathEnv(env);

      expect(env.CORESIMULATOR_DEVICE_SET_PATH).toBe(absolutePath);
    });
  });

  test("leaves a missing or blank CORESIMULATOR_DEVICE_SET_PATH untouched", () => {
    const missing: { CORESIMULATOR_DEVICE_SET_PATH?: string } = {};
    normalizeCoreSimulatorDeviceSetPathEnv(missing);
    expect(missing.CORESIMULATOR_DEVICE_SET_PATH).toBeUndefined();

    const blank = { CORESIMULATOR_DEVICE_SET_PATH: "   " };
    normalizeCoreSimulatorDeviceSetPathEnv(blank);
    expect(blank.CORESIMULATOR_DEVICE_SET_PATH).toBe("   ");
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
    const resolvedForEveryConsumer = withDaemonLaunchCwd(launchDirectory, () => {
      const env = { CORESIMULATOR_DEVICE_SET_PATH: "custom-devices" };
      normalizeCoreSimulatorDeviceSetPathEnv(env);
      return env.CORESIMULATOR_DEVICE_SET_PATH;
    });

    // Simulate reads from two different "current working directories" after a
    // daemon chdir — an already-absolute value ignores cwd entirely, so both
    // reads see the identical directory.
    expect(resolve("/unrelated/post-chdir/cwd", resolvedForEveryConsumer)).toBe(
      resolvedForEveryConsumer,
    );
    expect(resolve(launchDirectory, resolvedForEveryConsumer)).toBe(resolvedForEveryConsumer);
  });
});
