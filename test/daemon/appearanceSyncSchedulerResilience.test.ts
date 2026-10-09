import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type { AppearanceMode } from "../../src/models";
import type { AppearanceConfig } from "../../src/server/appearanceManager";
import { AppearanceSyncScheduler } from "../../src/daemon/AppearanceSyncScheduler";
import { FakeTimer } from "../fakes/FakeTimer";
import { PassiveWorkPolicy, parsePassiveWorkSettings } from "../../src/daemon/PassiveWorkPolicy";
import { logger } from "../../src/utils/logger";

function makeTarget(incarnation: number): BootedDevice & { incarnation: number } {
  return { deviceId: "emulator-5554", name: "emulator-5554", platform: "android", incarnation };
}

function makeScheduler(
  targets: () => (BootedDevice & { incarnation?: number })[],
  apply: (device: BootedDevice, mode: AppearanceMode) => Promise<void>,
  options: { timer?: FakeTimer; applyDeadlineMs?: number } = {},
): AppearanceSyncScheduler {
  return new AppearanceSyncScheduler(options.timer ?? new FakeTimer(), {
    isEnabled: () => true,
    getConfig: async () => ({ syncWithHost: true }) as AppearanceConfig,
    resolveMode: async () => "dark",
    getTargets: targets,
    apply,
    applyDeadlineMs: options.applyDeadlineMs,
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

/**
 * Issue #2784: the appearance sync is a best-effort background task started via
 * fire-and-forget `void this.trigger()` in Daemon.start() and on an interval. A
 * failed appearance read (transient DB error, or a missing/malformed
 * appearance_configs row) must NOT float an unhandledRejection that crashes an
 * otherwise-healthy daemon into a restart loop — trigger() must swallow it.
 */
describe("AppearanceSyncScheduler resilience", () => {
  afterEach(() => {
    mock.restore();
  });

  test("trigger resolves (does not reject) when the config read fails", async () => {
    const getConfig = mock(async (): Promise<AppearanceConfig> => {
      throw new Error("no such table: appearance_configs");
    });
    const scheduler = new AppearanceSyncScheduler(new FakeTimer(), {
      isEnabled: () => true,
      getConfig,
      resolveMode: async () => "dark",
      getTargets: () => [makeTarget(1)],
      apply: async () => {},
    });
    // If trigger() re-threw, this await would reject and fail the test.
    await expect(scheduler.trigger()).resolves.toBeUndefined();
    expect(getConfig).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  test("syncs a same-serial replacement with a new incarnation", async () => {
    let target = makeTarget(1);
    const applied: BootedDevice[] = [];
    const scheduler = makeScheduler(
      () => [target],
      async (device) => {
        applied.push(device);
      },
    );

    await scheduler.trigger();
    target = makeTarget(2);
    await scheduler.trigger();

    expect(applied).toHaveLength(2);
    await scheduler.stop();
  });

  test("startup sync touches only the acquired Android device", async () => {
    const devices = [makeTarget(1), { ...makeTarget(1), deviceId: "emulator-5556" }];
    const applied: string[] = [];
    const scheduler = makeScheduler(
      () => devices.filter((device) => device.deviceId === "emulator-5554"),
      async (device) => {
        applied.push(device.deviceId);
      },
    );

    await scheduler.trigger();

    expect(applied).toEqual(["emulator-5554"]);
    await scheduler.stop();
  });

  test("daemon scope picks up acquired and allowlisted devices on later ticks", async () => {
    const devices = [
      makeTarget(1),
      { ...makeTarget(1), deviceId: "emulator-5556" },
      { ...makeTarget(1), deviceId: "emulator-5558" },
    ];
    const owned = new Set<string>();
    const policy = new PassiveWorkPolicy(
      parsePassiveWorkSettings(
        { AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES: "emulator-5558" },
        "AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET",
      ),
      (id) => owned.has(id),
    );
    const applied: string[] = [];
    const scheduler = makeScheduler(
      () => [],
      async (device) => {
        applied.push(device.deviceId);
      },
    );
    scheduler.setScope({
      getTargets: () =>
        devices.filter((device) => policy.allows("android", "appearance-sync", device.deviceId)),
      isEnabled: () => policy.isAppearanceSyncEnabled(),
    });

    await scheduler.trigger();
    expect(applied).toEqual(["emulator-5558"]);
    owned.add("emulator-5554");
    await scheduler.trigger();
    expect(applied).toEqual(["emulator-5558", "emulator-5554"]);
    await scheduler.stop();
  });

  test("daemon scope does not sync pooled Android devices without a session or allowlist", async () => {
    const devices = [makeTarget(1), { ...makeTarget(1), deviceId: "emulator-5556" }];
    const policy = new PassiveWorkPolicy(
      parsePassiveWorkSettings({}, "AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET"),
      () => false,
    );
    const applied: string[] = [];
    const scheduler = makeScheduler(
      () => [],
      async (device) => {
        applied.push(device.deviceId);
      },
    );
    scheduler.setScope({
      getTargets: () =>
        devices.filter((device) => policy.allows("android", "appearance-sync", device.deviceId)),
    });

    await scheduler.trigger();
    expect(applied).toEqual([]);
    await scheduler.stop();
  });

  test("startup secret disables all appearance sync", async () => {
    const applied: string[] = [];
    const scheduler = new AppearanceSyncScheduler(new FakeTimer(), {
      getConfig: async () => ({ syncWithHost: true }) as AppearanceConfig,
      resolveMode: async () => "dark",
      getTargets: () => [makeTarget(1)],
      apply: async (device) => {
        applied.push(device.deviceId);
      },
      isEnabled: () => false,
    });

    await scheduler.trigger();
    await scheduler.syncDevice(makeTarget(1));

    expect(applied).toEqual([]);
    await scheduler.stop();
  });

  test("applies appearance sync when a session acquires a device later", async () => {
    const acquired = makeTarget(1);
    const applied: string[] = [];
    const scheduler = makeScheduler(
      () => [],
      async (device) => {
        applied.push(device.deviceId);
      },
    );

    await scheduler.syncDevice(acquired);

    expect(applied).toEqual(["emulator-5554"]);
    await scheduler.stop();
  });

  test("stop waits for an in-flight apply and prevents later targets", async () => {
    let finishApply: (() => void) | undefined;
    const applied: BootedDevice[] = [];
    const targets = [makeTarget(1), { ...makeTarget(2), deviceId: "emulator-5556" }];
    const scheduler = makeScheduler(
      () => targets,
      async (device) => {
        applied.push(device);
        await new Promise<void>((resolve) => {
          finishApply = resolve;
        });
      },
    );

    const tick = scheduler.trigger();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = scheduler.stop();
    expect(finishApply).toBeDefined();
    finishApply?.();
    await stopping;
    await tick;
    expect(applied).toHaveLength(1);
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  test("a hung first device hits the default deadline and lets the next device sync", async () => {
    const timer = new FakeTimer();
    const targets = [makeTarget(1), { ...makeTarget(1), deviceId: "emulator-5556" }];
    const applied: string[] = [];
    const scheduler = makeScheduler(
      () => targets,
      async (device) => {
        applied.push(device.deviceId);
        if (device.deviceId === targets[0].deviceId) {
          await new Promise<void>(() => {});
        }
      },
      { timer },
    );
    let finished = false;
    const tick = scheduler.trigger().then(() => {
      finished = true;
    });
    await flushMicrotasks();
    expect(applied).toEqual([targets[0].deviceId]);
    timer.advanceTime(10_001);
    await flushMicrotasks();
    expect(applied).toEqual(targets.map((device) => device.deviceId));
    expect(finished).toBe(true);
    await tick;
    await scheduler.stop();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a timed-out apply stays single-flight and retries only after the underlying apply settles", async () => {
    const timer = new FakeTimer();
    let finishApply!: () => void;
    let calls = 0;
    const scheduler = makeScheduler(
      () => [makeTarget(1)],
      async () => {
        calls++;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            finishApply = resolve;
          });
        }
      },
      { timer, applyDeadlineMs: 25 },
    );
    let finished = false;
    const tick = scheduler.trigger().then(() => {
      finished = true;
    });
    await flushMicrotasks();
    timer.advanceTime(26);
    await flushMicrotasks();
    expect(finished).toBe(true);
    await tick;
    await scheduler.trigger();
    await scheduler.syncDevice(makeTarget(1));
    expect(calls).toBe(1);
    finishApply();
    await flushMicrotasks();
    await scheduler.trigger();
    expect(calls).toBe(2);
    await scheduler.trigger();
    expect(calls).toBe(2);
    await scheduler.stop();
  });

  test("syncDevice skips a device while tick has its apply in flight", async () => {
    let finishApply!: () => void;
    let calls = 0;
    const scheduler = makeScheduler(
      () => [makeTarget(1)],
      () => {
        calls++;
        return new Promise<void>((resolve) => {
          finishApply = resolve;
        });
      },
    );
    const tick = scheduler.trigger();
    await flushMicrotasks();
    const syncing = scheduler.syncDevice(makeTarget(1));
    await flushMicrotasks();
    expect(calls).toBe(1);
    await syncing;
    finishApply();
    await tick;
    await scheduler.stop();
  });

  test("concurrent syncDevice calls and a tick share the device in-flight guard", async () => {
    let finishApply!: () => void;
    let calls = 0;
    const scheduler = makeScheduler(
      () => [makeTarget(1)],
      () => {
        calls++;
        return new Promise<void>((resolve) => {
          finishApply = resolve;
        });
      },
    );
    const first = scheduler.syncDevice(makeTarget(1));
    const second = scheduler.syncDevice(makeTarget(1));
    await flushMicrotasks();
    const tick = scheduler.trigger();
    await flushMicrotasks();
    expect(calls).toBe(1);
    await second;
    await tick;
    finishApply();
    await first;
    await scheduler.stop();
  });

  test("a rejected apply logs a warning and still lets the next target sync", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const targets = [makeTarget(1), { ...makeTarget(1), deviceId: "emulator-5556" }];
    const applied: string[] = [];
    const scheduler = makeScheduler(
      () => targets,
      async (device) => {
        applied.push(device.deviceId);
        if (device.deviceId === targets[0].deviceId) {
          throw new Error("apply failed");
        }
      },
    );
    await scheduler.trigger();
    expect(applied).toEqual(targets.map((device) => device.deviceId));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(targets[0].deviceId));
    await scheduler.stop();
  });

  test("a late rejection after the deadline is logged without an unhandled rejection", async () => {
    const timer = new FakeTimer();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    let rejectApply!: (error: Error) => void;
    let calls = 0;
    const scheduler = makeScheduler(
      () => [makeTarget(1)],
      () => {
        calls++;
        return calls === 1
          ? new Promise<void>((_resolve, reject) => {
              rejectApply = reject;
            })
          : Promise.resolve();
      },
      { timer, applyDeadlineMs: 25 },
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let finished = false;
      const tick = scheduler.trigger().then(() => {
        finished = true;
      });
      await flushMicrotasks();
      timer.advanceTime(26);
      await flushMicrotasks();
      expect(finished).toBe(true);
      await tick;
      const lateError = new Error("late apply failure");
      rejectApply(lateError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("emulator-5554"), lateError);
      await scheduler.trigger();
      expect(calls).toBe(2);
      await scheduler.stop();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("stop waits only until a hung tick's per-device deadline and prevents later targets", async () => {
    const timer = new FakeTimer();
    const applied: string[] = [];
    const scheduler = makeScheduler(
      () => [makeTarget(1), { ...makeTarget(1), deviceId: "emulator-5556" }],
      async (device) => {
        applied.push(device.deviceId);
        await new Promise<void>(() => {});
      },
      { timer, applyDeadlineMs: 25 },
    );
    const tick = scheduler.trigger();
    await flushMicrotasks();
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);
    timer.advanceTime(26);
    await flushMicrotasks();
    expect(stopped).toBe(true);
    await stopping;
    await tick;
    expect(applied).toEqual(["emulator-5554"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
