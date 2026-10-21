import { expect, test } from "bun:test";
import { z } from "zod";
import {
  createSleepGapDetector,
  markRowsHostSlept,
  parsePmsetSleepWake,
  readPmsetSleepIntervals,
  sleepIntervalsFromEvents,
  summarizeHostSleepRows,
} from "../../scripts/manual-test/hostSleep";
import { FakeTimer } from "../fakes/FakeTimer";

const fixtureAsset: { default: unknown } = await import(
  new URL("../fixtures/manual-test-host/pmset-log-sleep-wake.txt", import.meta.url).href,
  { with: { type: "text" } }
);
const capture = z.string().parse(fixtureAsset.default);
const ms = (value: string): number => Date.parse(value);

test("sleep gap detector identifies sleep and advances its baseline", () => {
  const timer = new FakeTimer();
  const detector = createSleepGapDetector(timer);
  timer.simulateHostSleep(6000);
  expect(detector.sample()).toEqual({ startMs: 0, endMs: 6000, sleptMs: 6000 });
  expect(detector.gaps()).toEqual([{ startMs: 0, endMs: 6000, sleptMs: 6000 }]);
  expect(detector.sample()).toBeUndefined();
  expect(detector.gaps()).toHaveLength(1);
});

test("ordinary advance and below threshold sleep are ignored", () => {
  const timer = new FakeTimer();
  const detector = createSleepGapDetector(timer);
  timer.advanceTime(4000);
  expect(detector.sample()).toBeUndefined();
  timer.simulateHostSleep(4999);
  expect(detector.sample()).toBeUndefined();
});

test("detector is unavailable when monotonic time includes sleep or is absent", () => {
  const timer = new FakeTimer();
  timer.simulateSleepCountingMonotonicClock();
  const includesSleep = createSleepGapDetector(timer);
  timer.simulateHostSleep(10000);
  expect(includesSleep.available).toBe(false);
  expect(includesSleep.sample()).toBeUndefined();
  const noMonotonic = createSleepGapDetector({
    now: () => 0,
    sleep: timer.sleep.bind(timer),
    setTimeout: timer.setTimeout.bind(timer),
    clearTimeout: timer.clearTimeout.bind(timer),
    setInterval: timer.setInterval.bind(timer),
    clearInterval: timer.clearInterval.bind(timer),
  });
  expect(noMonotonic.available).toBe(false);
  expect(noMonotonic.sample()).toBeUndefined();
});

test("pmset parser reads offset timestamps and only sleep or wake categories", () => {
  const events = parsePmsetSleepWake(`${capture}\nAssertions\nWake Requests`);
  // The fixture has 16 Sleep/Wake/DarkWake category rows; its 8 Wake Requests rows are excluded.
  expect(events).toHaveLength(16);
  expect(events[0]).toEqual({ atMs: ms("2026-10-13T16:37:48-04:00"), kind: "wake" });
  expect(events.at(-1)).toEqual({ atMs: ms("2026-10-14T07:20:24-04:00"), kind: "wake" });
  expect(parsePmsetSleepWake("bad timestamp Sleep\n2026-10-14 06:09:22 -0400 Assertions")).toEqual(
    [],
  );
  expect(
    parsePmsetSleepWake(
      "2026-10-14 06:09:22 -0400 Wake Requests\n2026-10-14 06:09:23 -0400 WakeTime\n2026-10-14 06:09:24 -0400 WakeDetails",
    ),
  ).toEqual([]);
});

test("pmset events pair and clip sleep intervals to the requested window", () => {
  const events = parsePmsetSleepWake(capture);
  const intervals = sleepIntervalsFromEvents(
    events,
    ms("2026-10-13T17:40:00-04:00"),
    ms("2026-10-14T06:20:00-04:00"),
  );
  expect(
    intervals.find((interval) => interval.startMs === ms("2026-10-13T17:40:30-04:00")),
  ).toEqual({
    startMs: ms("2026-10-13T17:40:30-04:00"),
    endMs: ms("2026-10-13T17:47:38-04:00"),
    source: "pmset",
  });
  expect(intervals.at(-1)).toEqual({
    startMs: ms("2026-10-14T06:09:22-04:00"),
    endMs: ms("2026-10-14T06:20:00-04:00"),
    source: "pmset",
  });
});

test("Wake Requests does not end the fixture sleep interval", () => {
  const intervals = sleepIntervalsFromEvents(
    parsePmsetSleepWake(capture),
    ms("2026-10-14T06:00:00-04:00"),
    ms("2026-10-14T07:00:00-04:00"),
  );
  expect(intervals).toContainEqual({
    startMs: ms("2026-10-14T06:09:22-04:00"),
    endMs: ms("2026-10-14T06:26:02-04:00"),
    source: "pmset",
  });
  expect(
    markRowsHostSlept(
      [
        {
          id: "asleep",
          startedAt: "2026-10-14T06:15:00-04:00",
          endedAt: "2026-10-14T06:15:00-04:00",
        },
      ],
      intervals,
    ).map((row) => ("invalid" in row ? row.invalid : undefined))[0],
  ).toBe("host-slept");
});

test("zero-length sleep intervals are dropped after clipping", () => {
  expect(
    sleepIntervalsFromEvents(
      [
        { atMs: 10, kind: "sleep" },
        { atMs: 20, kind: "wake" },
      ],
      20,
      30,
    ),
  ).toEqual([]);
});

test("rows overlapping a sleep interval are copied and marked with exclusive boundaries", () => {
  const rows = [
    { id: "overlap", startedAt: "1970-01-01T00:00:05Z", endedAt: "1970-01-01T00:00:11Z" },
    { id: "before", startedAt: "1970-01-01T00:00:00Z", endedAt: "1970-01-01T00:00:09Z" },
    { id: "boundary", startedAt: "1970-01-01T00:00:20Z", endedAt: "1970-01-01T00:00:21Z" },
    { id: "invalid-time", startedAt: "bad", endedAt: "bad" },
  ];
  const marked = markRowsHostSlept(rows, [{ startMs: 10000, endMs: 20000, source: "clock" }]);
  expect(marked.map((row) => ("invalid" in row ? row.invalid : undefined))).toEqual([
    "host-slept",
    undefined,
    undefined,
    undefined,
  ]);
  expect(marked[0]).not.toBe(rows[0]);
  expect(summarizeHostSleepRows(marked)).toEqual([
    "host-slept: 1 evidence row(s) invalid",
    "  - overlap",
  ]);
  expect(summarizeHostSleepRows(rows)).toEqual([]);
});

test("a sleep ending exactly when a row starts does not mark it", () => {
  const rows = [
    { id: "after", startedAt: "1970-01-01T00:00:20Z", endedAt: "1970-01-01T00:00:21Z" },
    { id: "point-inside", startedAt: "1970-01-01T00:00:15Z", endedAt: "1970-01-01T00:00:15Z" },
  ];
  expect(
    markRowsHostSlept(rows, [{ startMs: 10000, endMs: 20000, source: "clock" }]).map((row) =>
      "invalid" in row ? row.invalid : undefined,
    ),
  ).toEqual([undefined, "host-slept"]);
});

test("pmset reader reports parsed intervals, exit failures, and thrown errors", async () => {
  const start = ms("2026-10-13T17:40:00-04:00");
  const end = ms("2026-10-13T17:50:00-04:00");
  const success = await readPmsetSleepIntervals(
    {
      runCapture: async (command, args, timeoutMs) => {
        expect([command, args, timeoutMs]).toEqual(["pmset", ["-g", "log"], 5000]);
        return { exitCode: 0, stdout: capture, stderr: "" };
      },
    },
    start,
    end,
  );
  expect(success).toHaveProperty("intervals");
  expect(
    await readPmsetSleepIntervals(
      { runCapture: async () => ({ exitCode: 1, stdout: "", stderr: "denied" }) },
      start,
      end,
    ),
  ).toEqual({ unavailable: "denied" });
  expect(
    await readPmsetSleepIntervals(
      {
        runCapture: async () => {
          throw new Error("runner failed");
        },
      },
      start,
      end,
    ),
  ).toEqual({ unavailable: "runner failed" });
});
