import { describe, expect, test } from "bun:test";
import {
  STARTUP_MAINTENANCE_SLOW_WARNING_MS,
  startStartupMaintenance,
} from "../../src/utils/startupMaintenance";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeTimer } from "../fakes/FakeTimer";

function pendingPromise(): Promise<void> {
  return new Promise<void>(() => {});
}

describe("startStartupMaintenance", () => {
  test("returns while Android and iOS cleanup remain pending so request readiness is not delayed", async () => {
    const timer = new FakeTimer();
    const log = new FakeLogger();
    let androidStarted = false;
    let iosStarted = false;

    startStartupMaintenance({
      startNativeHelperSweep: async () => {},
      platform: "darwin",
      startAndroidSweep: () => {
        androidStarted = true;
        return pendingPromise();
      },
      startIosReap: () => {
        iosStarted = true;
        return pendingPromise();
      },
      timer,
      logger: log,
    });

    expect(androidStarted).toBe(true);
    expect(iosStarted).toBe(true);
  });

  test("logs cleanup rejection without surfacing it to startup", async () => {
    const timer = new FakeTimer();
    const log = new FakeLogger();

    startStartupMaintenance({
      startNativeHelperSweep: async () => {},
      platform: "linux",
      startAndroidSweep: async () => {
        throw new Error("temp directory unavailable");
      },
      startIosReap: () => pendingPromise(),
      timer,
      logger: log,
    });

    await Promise.resolve();

    expect(log.at("warn").map((message) => message.message)).toEqual([
      expect.stringContaining("Android CtrlProxy prefetch cleanup failed"),
    ]);
  });

  test("logs a timeout while allowing the unfinished cleanup to stay backgrounded", () => {
    const timer = new FakeTimer();
    const log = new FakeLogger();

    startStartupMaintenance({
      startNativeHelperSweep: () => pendingPromise(),
      platform: "linux",
      startAndroidSweep: () => pendingPromise(),
      startIosReap: () => pendingPromise(),
      timer,
      logger: log,
    });
    timer.advanceTime(STARTUP_MAINTENANCE_SLOW_WARNING_MS);

    expect(log.at("warn").map((message) => message.message)).toEqual([
      expect.stringContaining("Android CtrlProxy prefetch cleanup exceeded"),
      expect.stringContaining("native helper cleanup exceeded"),
    ]);
  });
});

for (const platform of ["darwin", "linux", "win32"] as const) {
  test(`native helper cleanup starts and survives rejection on ${platform}`, async () => {
    const timer = new FakeTimer();
    const logger = new FakeLogger();
    let calls = 0;
    startStartupMaintenance({
      platform,
      timer,
      logger,
      startAndroidSweep: async () => {},
      startIosReap: async () => {},
      startNativeHelperSweep: async () => {
        calls++;
        throw new Error("unavailable");
      },
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(logger.at("warn").map((m) => m.message)).toEqual([
      expect.stringContaining("native helper cleanup failed"),
    ]);
  });
}
