import { expect, describe, test, afterEach } from "bun:test";
import {
  DefaultPerformanceTracker,
  setDebugPerfEnabled,
  type TimingEntry,
} from "../../src/utils/PerformanceTracker";
import {
  ambientPerfFor,
  getPerfTracker,
  runWithPerfTracker,
  trackAmbient,
} from "../../src/utils/PerfContext";
import { FakeTimer } from "../fakes/FakeTimer";

describe("PerfContext", function () {
  afterEach(function () {
    setDebugPerfEnabled(false);
  });

  describe("ambientPerfFor gating", function () {
    test("returns a no-op tracker when --debug-perf is off, so ambient spans are dropped", async function () {
      setDebugPerfEnabled(false);
      const alwaysOn = new DefaultPerformanceTracker(new FakeTimer());

      await runWithPerfTracker(ambientPerfFor(alwaysOn), async () => {
        await trackAmbient("adb shell getprop", async () => undefined);
      });

      // The always-on tracker must not have collected the ambient client span.
      expect(alwaysOn.getTimings()).toEqual([]);
    });

    test("returns the real tracker when --debug-perf is on", async function () {
      setDebugPerfEnabled(true);
      const alwaysOn = new DefaultPerformanceTracker(new FakeTimer());

      await runWithPerfTracker(ambientPerfFor(alwaysOn), async () => {
        await trackAmbient("adb shell getprop", async () => undefined);
      });

      const names = (alwaysOn.getTimings() as TimingEntry[]).map((entry) => entry.name);
      expect(names).toContain("adb shell getprop");
    });
  });
  test("getPerfTracker returns a no-op tracker when none is established", function () {
    const tracker = getPerfTracker();
    expect(tracker.isEnabled()).toBe(false);
    expect(tracker.getTimings()).toBeNull();
  });

  test("trackAmbient is a no-op (still runs fn) outside a tracker scope", async function () {
    const result = await trackAmbient("orphan", async () => "value");
    expect(result).toBe("value");
  });

  test("code beneath runWithPerfTracker records into the established tracker", async function () {
    const fakeTimer = new FakeTimer();
    const tracker = new DefaultPerformanceTracker(fakeTimer);

    const resultPromise = runWithPerfTracker(tracker, async () => {
      // Simulate a deep platform-client call that only sees the ambient tracker.
      return trackAmbient("adb devices", async () => {
        await fakeTimer.sleep(7);
        return "ok";
      });
    });
    fakeTimer.advanceTime(7);
    const result = await resultPromise;

    expect(result).toBe("ok");
    const timings = tracker.getTimings() as TimingEntry[];
    expect(timings).toHaveLength(1);
    expect(timings[0].name).toBe("adb devices");
    expect(timings[0].durationMs).toBe(7);
  });

  test("the ambient tracker is restored after a nested scope settles", async function () {
    const outer = new DefaultPerformanceTracker(new FakeTimer());
    const inner = new DefaultPerformanceTracker(new FakeTimer());

    await runWithPerfTracker(outer, async () => {
      expect(getPerfTracker()).toBe(outer);
      await runWithPerfTracker(inner, async () => {
        expect(getPerfTracker()).toBe(inner);
      });
      expect(getPerfTracker()).toBe(outer);
    });
  });

  test("concurrent ambient commands each land as siblings under the tracker", async function () {
    const fakeTimer = new FakeTimer();
    const tracker = new DefaultPerformanceTracker(fakeTimer);

    const runPromise = runWithPerfTracker(tracker, async () => {
      await Promise.all([
        trackAmbient("adb shell a", async () => {
          await fakeTimer.sleep(3);
        }),
        trackAmbient("adb shell b", async () => {
          await fakeTimer.sleep(5);
        }),
      ]);
    });
    fakeTimer.advanceTime(5);
    await runPromise;

    const timings = tracker.getTimings() as TimingEntry[];
    const names = timings.map((entry) => entry.name).sort();
    expect(names).toEqual(["adb shell a", "adb shell b"]);
  });
});
