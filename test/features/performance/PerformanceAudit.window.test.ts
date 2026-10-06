import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PerformanceAudit } from "../../../src/features/performance/PerformanceAudit";
import {
  PERF_AUDIT_WINDOW_MS,
  computeCpuUsagePercent,
  computeJankWindow,
  counterDelta,
  parseJankyFrames,
  parseProcStat,
  type CpuSample,
  type GfxCounterSample,
} from "../../../src/features/performance/PerformanceAuditWindow";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { loadAndroidHomeObserve } from "../../fixtures/observe/observeFixture";

/**
 * Issue #10094: CPU usage was process lifetime ticks divided by DEVICE uptime
 * (the 80% threshold could never trip) and jank was the sum of three
 * overlapping cumulative gfxinfo counters compared with a per-second budget.
 *
 * Parser inputs below come from the captured `android-home.json` observe
 * result (a real `/proc/<pid>/stat` and `dumpsys gfxinfo` from an emulator).
 * No capture exists of a busy app or of `/proc/uptime`, so the busy-app cases
 * test the arithmetic on parsed numbers. To capture them:
 *   adb shell cat /proc/uptime
 *   adb shell cat /proc/$(adb shell pidof <pkg>)/stat   (twice, ~500 ms apart)
 *   adb shell dumpsys gfxinfo <pkg>                      (twice, ~500 ms apart, under load)
 */
const captured = loadAndroidHomeObserve().observe.performanceAudit!.metrics;
const capturedStat = captured.cpuStatsRaw!;
const capturedGfxinfo = captured.gfxinfoRaw!;

const thresholds = {
  frameTimeThresholdMs: 16.67,
  p50ThresholdMs: 15,
  p90ThresholdMs: 16.67,
  p95ThresholdMs: 20,
  p99ThresholdMs: 25,
  jankCountThreshold: 5,
  cpuUsageThresholdPercent: 80,
  touchLatencyThresholdMs: 33,
};

type AuditMetrics = Awaited<ReturnType<PerformanceAudit["collectMetrics"]>>;

const baseMetrics: AuditMetrics = {
  p50Ms: null,
  p90Ms: null,
  p95Ms: null,
  p99Ms: null,
  jankCount: null,
  missedVsyncCount: null,
  slowUiThreadCount: null,
  frameDeadlineMissedCount: null,
  cpuUsagePercent: null,
  threadCount: null,
  touchLatencyMs: null,
  anrDetected: false,
  anrDetails: null,
  timeToFirstFrameMs: null,
  timeToInteractiveMs: null,
  frameRateFps: null,
  gfxinfoRaw: null,
  cpuStatsRaw: null,
};

const cpu = (processTicks: number, uptimeSeconds: number, startTimeTicks = 875): CpuSample => ({
  processTicks,
  startTimeTicks,
  uptimeSeconds,
});

const gfx = (overrides: Partial<GfxCounterSample> = {}): GfxCounterSample => ({
  totalFrames: 20000,
  jankyFrames: 12,
  missedVsync: 4,
  slowUiThread: 3,
  frameDeadlineMissed: 5,
  ...overrides,
});

describe("computeCpuUsagePercent", () => {
  test("a process that used a full core over the interval reads 100% on a long-uptime device", () => {
    // 6000 lifetime ticks on a device up for two days: the old formula gave 0.0347%.
    const start = cpu(6000, 172800);
    const end = cpu(6050, 172800.5);
    expect(computeCpuUsagePercent(start, end)).toBeCloseTo(100, 6);
    expect(6000 / (172800 * 100) / 0.01).toBeLessThan(0.04); // what the old code reported
  });

  test("an idle interval reads 0% regardless of lifetime CPU time", () => {
    expect(computeCpuUsagePercent(cpu(8489, 74390.96), cpu(8489, 74391.46))).toBe(0);
  });

  test("a multi-threaded process can exceed one core", () => {
    expect(computeCpuUsagePercent(cpu(0, 10), cpu(150, 10.5))).toBeCloseTo(300, 6);
  });

  test("returns null when the samples are not the same process", () => {
    expect(computeCpuUsagePercent(cpu(100, 10, 875), cpu(150, 10.5, 99999))).toBeNull();
  });

  test("returns null when ticks went backwards or no time elapsed", () => {
    expect(computeCpuUsagePercent(cpu(150, 10), cpu(100, 10.5))).toBeNull();
    expect(computeCpuUsagePercent(cpu(100, 10), cpu(150, 10))).toBeNull();
    expect(computeCpuUsagePercent(cpu(100, 10), cpu(150, 9))).toBeNull();
  });
});

describe("computeJankWindow", () => {
  test("identical cumulative readings mean no jank in the window (issue scenario: 12 over 20000 frames)", () => {
    const window = computeJankWindow(gfx(), gfx(), 500);
    expect(window).toEqual({
      jankPerSecond: 0,
      missedVsync: 0,
      slowUiThread: 0,
      frameDeadlineMissed: 0,
    });
  });

  test("uses the de-duplicated Janky frames delta, not the sum of overlapping causes", () => {
    // Causes grew by 4 + 3 + 5 = 12 but they overlap; gfxinfo says 3 frames were janky.
    const window = computeJankWindow(
      gfx(),
      gfx({ jankyFrames: 15, missedVsync: 8, slowUiThread: 6, frameDeadlineMissed: 10 }),
      500,
    );
    expect(window?.jankPerSecond).toBe(6);
    expect(window?.missedVsync).toBe(4);
    expect(window?.slowUiThread).toBe(3);
    expect(window?.frameDeadlineMissed).toBe(5);
  });

  test("normalises the delta to a per-second rate over the real elapsed time", () => {
    const end = gfx({ jankyFrames: 14 });
    expect(computeJankWindow(gfx(), end, 500)?.jankPerSecond).toBe(4);
    expect(computeJankWindow(gfx(), end, 1000)?.jankPerSecond).toBe(2);
    expect(computeJankWindow(gfx(), end, 750)?.jankPerSecond).toBe(2.67);
  });

  test("without an aggregate it falls back to the largest cause delta, never their sum", () => {
    const start = gfx({ jankyFrames: null });
    const end = gfx({
      jankyFrames: null,
      missedVsync: 8,
      slowUiThread: 6,
      frameDeadlineMissed: 10,
    });
    expect(computeJankWindow(start, end, 1000)?.jankPerSecond).toBe(5);
  });

  test("a counter reset inside the window (live monitor resets gfxinfo) uses the post-reset value", () => {
    expect(counterDelta(100, 2)).toBe(2);
    expect(counterDelta(100, 100)).toBe(0);
    expect(counterDelta(100, 130)).toBe(30);
    const window = computeJankWindow(gfx({ jankyFrames: 100 }), gfx({ jankyFrames: 2 }), 1000);
    expect(window?.jankPerSecond).toBe(2);
  });

  test("returns null when no figure can be derived", () => {
    const none = gfx({
      jankyFrames: null,
      missedVsync: null,
      slowUiThread: null,
      frameDeadlineMissed: null,
    });
    expect(computeJankWindow(none, none, 500)).toBeNull();
    expect(computeJankWindow(gfx(), gfx(), 0)).toBeNull();
    expect(counterDelta(null, 5)).toBeNull();
    expect(counterDelta(5, null)).toBeNull();
  });
});

describe("parsers on captured output", () => {
  test("parseProcStat reads utime + stime and starttime from a real /proc/<pid>/stat", () => {
    // Fields 14/15 (utime 3430, stime 5059) and 22 (starttime 875) of the capture.
    expect(parseProcStat(capturedStat)).toEqual({ processTicks: 8489, startTimeTicks: 875 });
  });

  test("parseProcStat rejects unparseable output", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("1220 (s.nexuslauncher) S 369")).toBeNull();
  });

  test("parseJankyFrames reads the aggregate line of a real gfxinfo dump", () => {
    expect(parseJankyFrames(capturedGfxinfo)).toBe(0);
    expect(parseJankyFrames("")).toBeNull();
  });
});

describe("PerformanceAudit windowed CPU and jank", () => {
  const device = { deviceId: "test-device", name: "test", platform: "android" as const };
  const perf = new NoOpPerformanceTracker();
  let factory: FakeAdbClientFactory;
  let timer: FakeTimer;
  let audit: PerformanceAudit;

  beforeEach(() => {
    factory = new FakeAdbClientFactory();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    audit = new PerformanceAudit(device, factory, undefined, timer);
    factory.getFakeClient().setCommandResult("shell pidof 'com.example'", "1220\n");
    factory.getFakeClient().setCommandResult("shell ps -T -p '1220' | wc -l", "49\n");
  });

  const stubCpuSamples = (...samples: Array<CpuSample | null>) => {
    const queue = [...samples];
    return spyOn(audit, "readCpuSample").mockImplementation(async () => {
      const sample = queue.shift() ?? null;
      return sample ? { sample, statRaw: capturedStat } : null;
    });
  };

  test("CPU: a busy process on a long-uptime device now trips the 80% threshold", async () => {
    const reads = stubCpuSamples(cpu(6000, 172800), cpu(6050, 172800.5));

    const result = await audit["collectCpuMetrics"]("com.example", perf);

    expect(reads).toHaveBeenCalledTimes(2);
    expect(timer.getSleepHistory()).toEqual([PERF_AUDIT_WINDOW_MS]);
    expect(result.cpuUsagePercent).toBeCloseTo(100, 6);
    expect(result.threadCount).toBe(48);
    const violations = audit.validateMetrics(
      { ...baseMetrics, cpuUsagePercent: result.cpuUsagePercent! },
      thresholds,
    );
    expect(violations.map((v) => v.metric)).toEqual(["cpuUsage"]);
  });

  test("CPU: an idle process does not violate however much CPU it used since launch", async () => {
    stubCpuSamples(cpu(8489, 74390.96), cpu(8489, 74391.46));

    const result = await audit["collectCpuMetrics"]("com.example", perf);

    expect(result.cpuUsagePercent).toBe(0);
  });

  test("CPU: a restarted process yields no figure instead of a bogus delta", async () => {
    stubCpuSamples(cpu(6000, 100, 875), cpu(10, 100.5, 12345));

    const result = await audit["collectCpuMetrics"]("com.example", perf);

    expect(result.cpuUsagePercent).toBeNull();
    expect(result.threadCount).toBe(48);
  });

  test("CPU: unreadable samples yield no figure", async () => {
    stubCpuSamples(null, cpu(10, 100.5));

    expect((await audit["collectCpuMetrics"]("com.example", perf)).cpuUsagePercent).toBeNull();
  });

  test("CPU: no running process takes no samples and does not wait", async () => {
    factory.getFakeClient().setCommandResult("shell pidof 'com.example'", "\n");
    const reads = stubCpuSamples();

    const result = await audit["collectCpuMetrics"]("com.example", perf);

    expect(result.cpuUsagePercent).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("CPU: only the first pid of a multi-process package is sampled", async () => {
    factory.getFakeClient().setCommandResult("shell pidof 'com.example'", "1220 1301\n");
    factory.getFakeClient().setCommandResult("shell ps -T -p '1220' | wc -l", "49\n");
    const reads = stubCpuSamples(cpu(100, 10), cpu(100, 10.5));

    await audit["collectCpuMetrics"]("com.example", perf);

    expect(reads.mock.calls.map(([pid]) => pid)).toEqual(["1220", "1220"]);
  });

  test("jank: a high cumulative total with no new janky frames passes (issue scenario)", async () => {
    spyOn(audit, "readGfxSample").mockResolvedValue({ stdout: capturedGfxinfo, counters: gfx() });

    const result = await audit["collectGfxMetrics"]("com.example", perf);

    expect(timer.getSleepHistory()).toEqual([PERF_AUDIT_WINDOW_MS]);
    expect(result.jankCount).toBe(0);
    expect(result.missedVsyncCount).toBe(0);
    const violations = audit.validateMetrics(
      { ...baseMetrics, jankCount: result.jankCount! },
      thresholds,
    );
    expect(violations).toEqual([]);
  });

  test("jank: a burst of new janky frames inside the window violates the per-second budget", async () => {
    const readings = [gfx(), gfx({ jankyFrames: 16, missedVsync: 8, slowUiThread: 6 })];
    spyOn(audit, "readGfxSample").mockImplementation(async () => ({
      stdout: capturedGfxinfo,
      counters: readings.shift()!,
    }));

    const result = await audit["collectGfxMetrics"]("com.example", perf);

    // 4 janky frames in the 500 ms window = 8/s against a 5/s budget.
    expect(result.jankCount).toBe(8);
    const violations = audit.validateMetrics(
      { ...baseMetrics, jankCount: result.jankCount! },
      thresholds,
    );
    expect(violations).toEqual([
      expect.objectContaining({
        metric: "jankCount",
        threshold: 5,
        actual: 8,
        severity: "critical",
      }),
    ]);
  });

  test("jank: the real gfxinfo parse path returns zero for an idle captured dump read twice", async () => {
    factory
      .getFakeClient()
      .setCommandResult("shell dumpsys gfxinfo 'com.example'", capturedGfxinfo);

    const result = await audit["collectGfxMetrics"]("com.example", perf);

    expect(result.jankCount).toBe(0);
    expect(result.missedVsyncCount).toBe(0);
    expect(result.slowUiThreadCount).toBe(0);
    expect(result.frameDeadlineMissedCount).toBe(0);
    expect(result.gfxinfoRaw).toBe(capturedGfxinfo);
  });

  test("jank: an unreadable gfxinfo reading reports no figure rather than zero", async () => {
    factory.getFakeClient().setCommandResult("shell dumpsys gfxinfo 'com.example'", "");

    const result = await audit["collectGfxMetrics"]("com.example", perf);

    expect(result.jankCount).toBeNull();
    expect(result.missedVsyncCount).toBeNull();
  });

  test("collectMetrics measures both windows concurrently: one window of waiting, not two", async () => {
    spyOn(audit, "readGfxSample").mockResolvedValue({ stdout: capturedGfxinfo, counters: gfx() });
    stubCpuSamples(cpu(100, 10), cpu(125, 10.5));

    const metrics = await audit.collectMetrics("com.example", undefined, perf, {
      skipTouchLatency: true,
    });

    expect(timer.getSleepHistory()).toEqual([PERF_AUDIT_WINDOW_MS, PERF_AUDIT_WINDOW_MS]);
    expect(metrics.cpuUsagePercent).toBeCloseTo(50, 6);
    expect(metrics.jankCount).toBe(0);
  });
});
