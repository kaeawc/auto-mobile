import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { FakeTimer } from "../fakes/FakeTimer";
import { defaultTimer } from "../../src/utils/SystemTimer";

/**
 * Unit tests for the barrier path of CriticalSectionCoordinator
 * (awaitBarrier): synchronize devices at a point, then proceed concurrently
 * with NO serialized section (unlike enterCriticalSection).
 */
describe("CriticalSectionCoordinator.awaitBarrier", () => {
  let coordinator: CriticalSectionCoordinator;
  let fakeTimer: FakeTimer;
  let originalSetTimeout: typeof global.setTimeout;
  let originalClearTimeout: typeof global.clearTimeout;
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    originalSetTimeout = global.setTimeout;
    originalClearTimeout = global.clearTimeout;
    originalDateNow = Date.now;

    global.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      return fakeTimer.setTimeout(() => callback(...args), ms ?? 0);
    }) as typeof global.setTimeout;
    global.clearTimeout = ((handle: NodeJS.Timeout) => {
      fakeTimer.clearTimeout(handle);
    }) as typeof global.clearTimeout;
    Date.now = () => fakeTimer.now();

    coordinator = CriticalSectionCoordinator.getInstance();
    coordinator.reset();
  });

  afterEach(() => {
    Date.now = originalDateNow;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    fakeTimer.reset();
  });

  const wait = async (ms: number): Promise<void> => {
    const promise = defaultTimer.sleep(ms);
    fakeTimer.advanceTime(ms);
    await promise;
  };

  test("single device with deviceCount 1 proceeds immediately", async () => {
    const start = Date.now();
    await coordinator.awaitBarrier("solo", "device-1", 1);
    expect(Date.now() - start).toBeLessThan(100);
  });

  test("all devices are released only after the last arrives", async () => {
    const arrivals: Array<{ deviceId: string; at: number }> = [];
    const passes: Array<{ deviceId: string; at: number }> = [];

    const promises = ["device-1", "device-2", "device-3"].map(async (deviceId, index) => {
      await wait(index * 10); // stagger arrivals
      arrivals.push({ deviceId, at: Date.now() });
      await coordinator.awaitBarrier("sync", deviceId, 3);
      passes.push({ deviceId, at: Date.now() });
    });

    await Promise.all(promises);

    expect(passes.length).toBe(3);
    const lastArrival = Math.max(...arrivals.map((a) => a.at));
    // No device passes the barrier before the last one arrives.
    for (const p of passes) {
      expect(p.at).toBeGreaterThanOrEqual(lastArrival);
    }
  });

  test("does NOT serialize: device work overlaps after the barrier", async () => {
    const log: Array<{ deviceId: string; event: string; time: number }> = [];

    const deviceWork = async (deviceId: string) => {
      await coordinator.awaitBarrier("no-serialize", deviceId, 2);
      log.push({ deviceId, event: "start", time: Date.now() });
      await wait(20);
      log.push({ deviceId, event: "end", time: Date.now() });
    };

    await Promise.all([deviceWork("device-1"), deviceWork("device-2")]);

    // Both start before either ends — proof there is no mutual exclusion.
    const starts = log.filter((e) => e.event === "start").map((e) => e.time);
    const ends = log.filter((e) => e.event === "end").map((e) => e.time);
    expect(starts.length).toBe(2);
    expect(Math.max(...starts)).toBeLessThanOrEqual(Math.min(...ends));
  });

  test("times out if not all devices arrive", async () => {
    // Only device-1 arrives; device-2 never does.
    const promise = coordinator.awaitBarrier("missing", "device-1", 2, 100);
    fakeTimer.advanceTime(100);
    await expect(promise).rejects.toThrow(
      /Timeout waiting for critical section "missing"\. 1\/2 devices arrived after 100ms/,
    );
  });
});
