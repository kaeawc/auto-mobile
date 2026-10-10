import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  formatClockSemanticsReport,
  measureClockSemantics,
  parseProcUptimeSeconds,
  type ClockReading,
} from "../../scripts/ci/clockSemanticsReport";

function fakeReader(timer: FakeTimer, procUptime: boolean): () => ClockReading {
  return () => {
    const ms = timer.now();
    return {
      wallMs: ms,
      performanceMs: ms,
      hrtimeNs: ms * 1e6,
      bunNanoseconds: undefined,
      osUptimeSec: 1000 + ms / 1000,
      processUptimeSec: ms / 1000,
      procUptimeSec: procUptime ? 5000 + ms / 1000 : undefined,
    };
  };
}

describe("measureClockSemantics", () => {
  test("reports per-clock elapsed time and deltas from performance.now over the sleep", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const report = await measureClockSemantics({
      read: fakeReader(timer, true),
      timer,
      sleepMs: 100,
      platform: "linux",
      arch: "x64",
      bunVersion: "1.4.2",
      nodeVersion: "v24.0.0",
      verifiedBunLine: "1.3",
      tableSaysMonotonicIncludesHostSleep: true,
    });
    expect(report.elapsedMs["performance.now"]).toBe(100);
    expect(report.elapsedMs["/proc/uptime"]).toBe(100);
    expect(report.elapsedMs["Bun.nanoseconds"]).toBeUndefined();
    expect(report.deltaFromPerformanceMs["Date.now"]).toBe(0);
    expect(report.deltaFromPerformanceMs["Bun.nanoseconds"]).toBeUndefined();
    expect(report.bunVersion).toBe("1.4.2");
    expect(report.tableSaysMonotonicIncludesHostSleep).toBe(true);
  });

  test("a non-linux run has no /proc/uptime entry", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const report = await measureClockSemantics({
      read: fakeReader(timer, false),
      timer,
      sleepMs: 50,
      platform: "darwin",
      arch: "arm64",
      bunVersion: undefined,
      nodeVersion: "v24.0.0",
      verifiedBunLine: "1.3",
      tableSaysMonotonicIncludesHostSleep: false,
    });
    expect(report.elapsedMs["/proc/uptime"]).toBeUndefined();
    expect(report.elapsedMs["os.uptime"]).toBe(50);
  });
});

describe("parseProcUptimeSeconds", () => {
  test("reads the first field and rejects anything else", () => {
    expect(parseProcUptimeSeconds("12345.67 98765.43\n")).toBe(12345.67);
    expect(parseProcUptimeSeconds("")).toBeUndefined();
    expect(parseProcUptimeSeconds("abc 1")).toBeUndefined();
    expect(parseProcUptimeSeconds("-1 2")).toBeUndefined();
  });
});

describe("formatClockSemanticsReport", () => {
  test("wraps runs in stable JSON ending with a newline", () => {
    const text = formatClockSemanticsReport([]);
    expect(JSON.parse(text)).toEqual({ runs: [] });
    expect(text.endsWith("\n")).toBe(true);
  });
});
