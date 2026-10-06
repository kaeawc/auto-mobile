import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { ExecResult } from "../../src/models";
import { DefaultWorkProfileMonitor } from "../../src/utils/WorkProfileMonitor";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function packageListResult(): ExecResult {
  const stdout = "package:com.example.app1\n";
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value: string) => stdout.includes(value),
  };
}

// Stands in for the primary-profile snapshot a committed rebuild wrote. A work
// profile refresh only patches an existing snapshot (#10041).
async function seedPrimarySnapshot(repo: FakeInstalledAppsRepository): Promise<void> {
  await repo.replaceInstalledApps("emulator-5554", [
    {
      device_id: "emulator-5554",
      user_id: 0,
      package_name: "com.example.primary",
      is_system: 0,
      installed_at: 500,
      last_verified_at: 500,
    },
  ]);
}

describe("WorkProfileMonitor", () => {
  let timer: FakeTimer;
  let adb: FakeAdbExecutor;
  let repo: FakeInstalledAppsRepository;
  let monitor: DefaultWorkProfileMonitor;

  beforeEach(() => {
    timer = new FakeTimer();
    adb = new FakeAdbExecutor();
    repo = new FakeInstalledAppsRepository();

    monitor = new DefaultWorkProfileMonitor({
      deviceId: "emulator-5554",
      adb,
      installedAppsStore: repo,
      timer,
      pollIntervalMs: 5000,
    });

    // Set up default package list response
    adb.setCommandResponse("pm list packages --user", {
      stdout: "package:com.example.app1\npackage:com.example.app2\n",
      stderr: "",
      toString: () => "package:com.example.app1\npackage:com.example.app2\n",
      trim: () => "package:com.example.app1\npackage:com.example.app2",
      includes: (s: string) => "package:com.example.app1\npackage:com.example.app2\n".includes(s),
    });
  });

  afterEach(() => {
    monitor.stop();
    timer.reset();
  });

  test("starts and stops correctly", () => {
    expect(monitor.isRunning()).toBe(false);

    monitor.start();
    expect(monitor.isRunning()).toBe(true);

    monitor.stop();
    expect(monitor.isRunning()).toBe(false);
  });

  test("does not double-start", () => {
    monitor.start();
    monitor.start(); // Should be a no-op

    expect(monitor.isRunning()).toBe(true);
    expect(timer.getPendingIntervalCount()).toBe(1);
  });

  test("tracks profile states", () => {
    expect(monitor.getProfileStates()).toHaveLength(0);

    monitor.setProfileHasAccessibilityService(10, false);
    expect(monitor.getProfileStates()).toHaveLength(1);
    expect(monitor.getProfileStates()[0]).toEqual({
      userId: 10,
      hasAccessibilityService: false,
      lastRefreshMs: 0,
    });

    monitor.setProfileHasAccessibilityService(10, true);
    expect(monitor.getProfileStates()[0].hasAccessibilityService).toBe(true);
  });

  test("refreshes profile packages via ADB", async () => {
    await seedPrimarySnapshot(repo);
    timer.setCurrentTime(1000);
    monitor.setProfileHasAccessibilityService(10, false);

    await monitor.refreshProfile(10);

    // Check that packages were added to repository
    const apps = (await repo.listInstalledApps("emulator-5554")).filter((a) => a.user_id === 10);
    expect(apps).toHaveLength(2);
    expect(apps.map((a) => a.package_name).sort()).toEqual([
      "com.example.app1",
      "com.example.app2",
    ]);

    // Check lastRefreshMs was updated
    const state = monitor.getProfileStates()[0];
    expect(state.lastRefreshMs).toBe(1000);
  });

  test("does not turn an empty cache into a work-profile-only snapshot (#10041)", async () => {
    timer.setCurrentTime(1000);
    monitor.setProfileHasAccessibilityService(10, false);

    await monitor.refreshProfile(10);

    // listApps must rebuild every profile from the device, not serve profile 10 alone.
    expect(await repo.listInstalledApps("emulator-5554")).toHaveLength(0);
    expect(await repo.getCacheVerifiedAt("emulator-5554")).toBeNull();
    // The refresh itself still ran.
    expect(monitor.getProfileStates()[0].lastRefreshMs).toBe(1000);
  });

  test("polls only stale profiles (without accessibility service)", async () => {
    monitor.setProfileHasAccessibilityService(10, false); // Should poll
    monitor.setProfileHasAccessibilityService(11, true); // Should NOT poll

    monitor.start();

    // Advance time to trigger poll
    timer.advanceTime(5000);
    await Promise.resolve(); // Let async operations complete

    // Only user 10 should have been refreshed
    expect(adb.wasCommandExecuted("pm list packages --user 10")).toBe(true);
    expect(adb.wasCommandExecuted("pm list packages --user 11")).toBe(false);
  });

  test("continues refreshing profiles after one profile fails", async () => {
    await seedPrimarySnapshot(repo);
    adb.setCommandError("pm list packages --user 10", new Error("ADB command failed"));
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    monitor.setProfileHasAccessibilityService(10, false);
    monitor.setProfileHasAccessibilityService(11, false);
    monitor.start();

    timer.advanceTime(5000);
    for (let turn = 0; turn < 10; turn++) {
      await Promise.resolve();
    }

    expect(adb.wasCommandExecuted("pm list packages --user 10")).toBe(true);
    expect(adb.wasCommandExecuted("pm list packages --user 11")).toBe(true);
    const apps = await repo.listInstalledApps("emulator-5554");
    expect(apps.some((app) => app.user_id === 11)).toBe(true);
    expect(apps.some((app) => app.user_id === 10)).toBe(false);
    expect(warning).toHaveBeenCalledWith(
      "[WORK_PROFILE_MONITOR] Failed to refresh profile 10: Failed to refresh packages for work profile 10: ADB command failed",
    );
    warning.mockRestore();
  });

  test("does not overlap a slow polling tick with the next interval", async () => {
    const firstCommand = deferred<ExecResult>();
    let activeCommands = 0;
    let maxActiveCommands = 0;
    let commandCount = 0;
    const command = spyOn(adb, "executeCommand").mockImplementation(() => {
      commandCount++;
      activeCommands++;
      maxActiveCommands = Math.max(maxActiveCommands, activeCommands);
      const response =
        commandCount === 1 ? firstCommand.promise : Promise.resolve(packageListResult());
      return response.finally(() => {
        activeCommands--;
      });
    });
    monitor.setProfileHasAccessibilityService(10, false);
    monitor.start();

    timer.advanceTime(5000);
    timer.advanceTime(10000);
    expect(commandCount).toBe(1);
    expect(maxActiveCommands).toBe(1);

    firstCommand.resolve(packageListResult());
    for (let turn = 0; turn < 10; turn++) {
      await Promise.resolve();
    }
    timer.advanceTime(5000);

    expect(commandCount).toBe(2);
    expect(maxActiveCommands).toBe(1);
    command.mockRestore();
  });

  test("warns when an ADB command times out and runs the next polling tick", async () => {
    let commandCount = 0;
    const command = spyOn(adb, "executeCommand").mockImplementation((_cmd, timeoutMs) => {
      commandCount++;
      if (commandCount > 1) {
        return Promise.resolve(packageListResult());
      }
      return new Promise<ExecResult>((_resolve, reject) => {
        timer.setTimeout(() => reject(new Error("ADB command timed out")), timeoutMs);
      });
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    monitor.setProfileHasAccessibilityService(10, false);
    monitor.start();

    timer.advanceTime(5000);
    expect(command.mock.calls[0]?.[1]).toBe(10_000);
    timer.advanceTime(10_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    timer.advanceTime(5000);
    expect(commandCount).toBe(2);
    expect(warning).toHaveBeenCalledWith(
      "[WORK_PROFILE_MONITOR] Failed to refresh profile 10: Failed to refresh packages for work profile 10: ADB command timed out",
    );
    command.mockRestore();
    warning.mockRestore();
  });

  test("does not poll when all profiles have accessibility service", async () => {
    monitor.setProfileHasAccessibilityService(10, true);
    monitor.setProfileHasAccessibilityService(11, true);

    monitor.start();

    // Advance time to trigger poll
    timer.advanceTime(5000);
    await Promise.resolve();

    // No profile should have been refreshed
    expect(adb.wasCommandExecuted("pm list packages")).toBe(false);
  });

  test("updates profile state when accessibility service becomes available", async () => {
    monitor.setProfileHasAccessibilityService(10, false);
    expect(monitor.getProfileStates()[0].hasAccessibilityService).toBe(false);

    // Simulate accessibility service being enabled
    monitor.setProfileHasAccessibilityService(10, true);
    expect(monitor.getProfileStates()[0].hasAccessibilityService).toBe(true);

    monitor.start();

    // Advance time to trigger poll
    timer.advanceTime(5000);
    await Promise.resolve();

    // Profile should NOT have been polled since it now has accessibility service
    expect(adb.wasCommandExecuted("pm list packages")).toBe(false);
  });

  test("handles empty package list gracefully", async () => {
    // Create a fresh monitor without the default package list response
    const freshAdb = new FakeAdbExecutor();
    const freshMonitor = new DefaultWorkProfileMonitor({
      deviceId: "emulator-5554",
      adb: freshAdb,
      installedAppsStore: repo,
      timer,
      pollIntervalMs: 5000,
    });

    // Set empty response
    freshAdb.setDefaultResponse({
      stdout: "",
      stderr: "",
      toString: () => "",
      trim: () => "",
      includes: () => false,
    });

    freshMonitor.setProfileHasAccessibilityService(10, false);
    await freshMonitor.refreshProfile(10);

    const apps = await repo.listInstalledApps("emulator-5554");
    expect(apps).toHaveLength(0);
  });

  test("continues polling after refresh error", async () => {
    adb.setDefaultError(new Error("ADB connection lost"));

    monitor.setProfileHasAccessibilityService(10, false);
    monitor.start();

    // First poll should fail but not crash
    timer.advanceTime(5000);
    await Promise.resolve();

    // Monitor should still be running
    expect(monitor.isRunning()).toBe(true);
  });
});
