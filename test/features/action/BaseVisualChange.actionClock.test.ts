import { describe, expect, test } from "bun:test";
import {
  ACTION_CLOCK_REFRESH_INTERVAL_MS,
  ActionClockSkewCache,
  actionClockSkewCache,
} from "../../../src/features/action/ActionClockSkewCache";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { BootedDevice } from "../../../src/models";
import { DefaultPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { buildObserveResult } from "../../helpers/observeFixture";

const HOST_TIME = 1_000_000;

function harness(refreshIntervalMs = ACTION_CLOCK_REFRESH_INTERVAL_MS) {
  const timer = new FakeTimer();
  timer.setCurrentTime(HOST_TIME);
  const cache = new ActionClockSkewCache(timer, refreshIntervalMs);
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampSource("device-ms");
  let reads = 0;
  let measurement: () => Promise<number> = async () => timer.now() + 5_000;
  adb.getDeviceTimestampMs = async () => {
    reads++;
    return measurement();
  };
  const screen = new FakeObserveScreen();
  const observation = buildObserveResult({
    updatedAt: Number.MAX_SAFE_INTEGER,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  screen.setObserveResult(observation);
  const createAction = (deviceId = "clock-test", platform: BootedDevice["platform"] = "android") =>
    new BaseVisualChange({ deviceId, platform, name: deviceId }, adb, timer, () => undefined, {
      actionClockSkewCache: cache,
      observeScreen: screen,
      awaitIdle: new FakeAwaitIdle(),
      window: new FakeWindow(),
    });
  const run = async (
    action = createAction(),
    hostFloor?: () => number,
    dispatch: () => Promise<{ success: boolean }> = async () => ({ success: true }),
  ) => {
    const perf = new DefaultPerformanceTracker(timer);
    const result = await action.observedInteraction(dispatch, {
      previousObservation: observation,
      changeExpected: false,
      skipUiStability: true,
      deferPostActionScreenshot: true,
      observationHostTimestampProvider: hostFloor,
      perf,
    });
    expect(result.success).toBe(true);
    return { floor: screen.getExecuteOptions().at(-1)?.minTimestamp, timings: perf.getTimings() };
  };
  return {
    timer,
    cache,
    adb,
    createAction,
    run,
    reads: () => reads,
    measureWith: (read: () => Promise<number>) => {
      measurement = read;
    },
  };
}

describe("observed action clock cache", () => {
  test("10 actions across instances read the device clock once and retain the perf span", async () => {
    const h = harness();
    for (let index = 0; index < 10; index++) {
      const result = await h.run();
      expect(result.floor).toBe(h.timer.now() + 5_000);
      expect(result.timings).toContainEqual({ name: "getActionStartTime", durationMs: 0 });
      h.timer.advanceTime(10);
    }
    expect(h.reads()).toBe(1);
  });

  test.each([ACTION_CLOCK_REFRESH_INTERVAL_MS, 100])("refreshes at exactly %i ms", async (ttl) => {
    const h = harness(ttl);
    await h.run();
    h.timer.advanceTime(ttl - 1);
    await h.run();
    expect(h.reads()).toBe(1);
    h.timer.advanceTime(1);
    h.measureWith(async () => h.timer.now() - 20_000);
    expect((await h.run()).floor).toBe(h.timer.now() - 20_000);
    expect(h.reads()).toBe(2);
  });

  test("different device ids retain independent skews", async () => {
    const h = harness();
    expect((await h.run(h.createAction("ahead"))).floor).toBe(HOST_TIME + 5_000);
    h.measureWith(async () => h.timer.now() - 20_000);
    expect((await h.run(h.createAction("behind"))).floor).toBe(HOST_TIME - 20_000);
    expect((await h.run(h.createAction("ahead"))).floor).toBe(HOST_TIME + 5_000);
    expect(h.reads()).toBe(2);
  });

  test.each([5_000, -20_000])(
    "cached skew %i preserves the post-read floor and host conversion",
    async (skew) => {
      const h = harness();
      h.measureWith(async () => {
        const stamp = h.timer.now() + skew;
        h.timer.advanceTime(50);
        return stamp;
      });
      expect((await h.run()).floor).toBe(HOST_TIME + skew);
      h.timer.advanceTime(100);
      const start = h.timer.now();
      expect((await h.run()).floor).toBe(start + skew - 50);
      const result = await h.run(
        undefined,
        () => h.timer.now(),
        async () => {
          h.timer.advanceTime(10);
          return { success: true };
        },
      );
      expect(result.floor).toBe(start + 10 + skew - 50);
      expect(h.reads()).toBe(1);
    },
  );

  test("failed refresh uses host time and retries instead of retaining an expired skew", async () => {
    const h = harness(100);
    await h.run();
    h.timer.advanceTime(100);
    h.measureWith(async () => {
      throw new Error("device disconnected");
    });
    expect((await h.run()).floor).toBe(h.timer.now());
    h.measureWith(async () => h.timer.now() - 100);
    expect((await h.run()).floor).toBe(h.timer.now() - 100);
    expect(h.reads()).toBe(3);
  });

  test("a failed first read uses zero skew for host floors and retries the next action", async () => {
    const h = harness();
    h.measureWith(async () => {
      h.timer.advanceTime(50);
      throw new Error("clock read failed");
    });
    const failed = await h.run(
      undefined,
      () => h.timer.now(),
      async () => {
        h.timer.advanceTime(10);
        return { success: true };
      },
    );
    expect(failed.floor).toBe(h.timer.now());
    h.measureWith(async () => h.timer.now() + 100);
    expect((await h.run()).floor).toBe(h.timer.now() + 100);
    expect(h.reads()).toBe(2);
  });

  test("ADB host fallback is not cached as a device offset", async () => {
    const h = harness();
    h.adb.setDeviceTimestampSource("host");
    expect((await h.run()).floor).toBe(h.timer.now());
    h.timer.advanceTime(20);
    h.adb.setDeviceTimestampSource("device-ms");
    expect((await h.run()).floor).toBe(h.timer.now() + 5_000);
    expect(h.reads()).toBe(2);
  });

  test.each([undefined, null])(
    "unavailable measurement %s falls back to host time on each action",
    async (stamp) => {
      const h = harness();
      const action = h.createAction();
      let reads = 0;
      action.actionClockSkewCache = {
        getSkewMs: (id) =>
          h.cache.getSkewMs(id, async () => {
            reads++;
            return stamp;
          }),
      };
      expect((await h.run(action)).floor).toBe(h.timer.now());
      h.timer.advanceTime(20);
      expect((await h.run(action)).floor).toBe(h.timer.now());
      expect(reads).toBe(2);
    },
  );

  test("concurrent first actions across instances share one pending measurement", async () => {
    const h = harness();
    let resolveRead: (stamp: number) => void = () => {
      throw new Error("read not started");
    };
    const pendingRead = new Promise<number>((resolve) => {
      resolveRead = resolve;
    });
    let readStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    h.measureWith(() => {
      readStarted();
      return pendingRead;
    });
    const first = h.run();
    const second = h.run();
    await started;
    expect(h.reads()).toBe(1);
    resolveRead(HOST_TIME + 5_000);
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.floor)).toEqual([HOST_TIME + 5_000, HOST_TIME + 5_000]);
    expect(h.reads()).toBe(1);
  });

  test("iOS uses host time and zero skew without consulting the device clock", async () => {
    const h = harness();
    await h.run(); // An Android entry for the same id must not affect iOS.
    h.timer.advanceTime(10);
    const ios = h.createAction("clock-test", "ios");
    expect((await h.run(ios)).floor).toBe(h.timer.now());
    const result = await h.run(
      ios,
      () => h.timer.now(),
      async () => {
        h.timer.advanceTime(20);
        return { success: true };
      },
    );
    expect(result.floor).toBe(h.timer.now());
    expect(h.reads()).toBe(1);
  });
});

describe("clock measurement failures and session retirement", () => {
  test.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "unavailable timestamp %s is retried",
    async (stamp) => {
      const timer = new FakeTimer();
      const cache = new ActionClockSkewCache(timer);
      let reads = 0;
      const measure = async () => {
        reads++;
        return stamp;
      };
      expect(await cache.getSkewMs("device", measure)).toBeNull();
      expect(await cache.getSkewMs("device", measure)).toBeNull();
      expect(reads).toBe(2);
      expect(await cache.getSkewMs("device", async () => 20)).toBe(20);
    },
  );

  test("invalidation retires an in-flight read without overwriting the new session", async () => {
    const cache = new ActionClockSkewCache(new FakeTimer());
    let resolveRead: (stamp: number) => void = () => {
      throw new Error("read not started");
    };
    const read = new Promise<number>((resolve) => {
      resolveRead = resolve;
    });
    const stale = cache.getSkewMs("device", () => read);
    cache.invalidate("device");
    expect(await cache.getSkewMs("device", async () => 200)).toBe(200);
    resolveRead(100);
    expect(await stale).toBeNull();
    expect(await cache.getSkewMs("device", async () => 300)).toBe(200);
  });

  test("existing session reset hook retires the shared production cache", async () => {
    const id = "action-clock-reset-test";
    try {
      await actionClockSkewCache.getSkewMs(id, async () => HOST_TIME);
      let reads = 0;
      const measure = async () => {
        reads++;
        return HOST_TIME;
      };
      await actionClockSkewCache.getSkewMs(id, measure);
      expect(reads).toBe(0);
      displayTransitions.reset(id);
      await actionClockSkewCache.getSkewMs(id, measure);
      expect(reads).toBe(1);
    } finally {
      actionClockSkewCache.invalidate(id);
    }
  });
});
