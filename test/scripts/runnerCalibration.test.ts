import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arithmeticWork,
  type CalibrationClock,
  type CalibrationScheduler,
  formatCalibrationSample,
  maxSlowdown,
  parseCalibrationSamples,
  positiveNumberFromEnv,
  readCalibrationDirectory,
  runCalibrationProbe,
  shardSlowdowns,
  slowdownFactor,
} from "../../scripts/lib/runner-calibration";

/** A fake clock that advances by a fixed cost per event-loop turn. */
function fakeRuntime(turnCostsMs: number[]): {
  clock: CalibrationClock;
  scheduler: CalibrationScheduler;
  turns: () => number;
} {
  let nowMs = 0;
  let turns = 0;
  return {
    clock: { now: () => nowMs },
    scheduler: {
      yieldTurn: async () => {
        nowMs += turnCostsMs[Math.min(turns, turnCostsMs.length - 1)];
        turns += 1;
      },
    },
    turns: () => turns,
  };
}

describe("runCalibrationProbe", () => {
  test("records the fastest repetition so one pause does not read as starvation", async () => {
    // Repetition 1 pays a 40ms pause on its first turn; repetitions 2-3 cost 2ms per turn.
    const runtime = fakeRuntime([40, 2, 2, 2, 2, 2]);
    const result = await runCalibrationProbe(runtime.clock, runtime.scheduler, {
      turns: 2,
      iterations: 10,
      repetitions: 3,
    });
    expect(runtime.turns()).toBe(6);
    expect(result.elapsedMs).toBe(4);
    expect(result.checksum).toBe(arithmeticWork(10));
  });

  test("a uniformly starved runner reports the starved duration", async () => {
    const runtime = fakeRuntime([25]);
    const result = await runCalibrationProbe(runtime.clock, runtime.scheduler, {
      turns: 4,
      iterations: 1,
      repetitions: 2,
    });
    expect(result.elapsedMs).toBe(100);
  });

  test("runs at least one repetition", async () => {
    const runtime = fakeRuntime([3]);
    const result = await runCalibrationProbe(runtime.clock, runtime.scheduler, {
      turns: 1,
      iterations: 1,
      repetitions: 0,
    });
    expect(runtime.turns()).toBe(1);
    expect(result.elapsedMs).toBe(3);
  });
});

describe("slowdownFactor", () => {
  test("is the elapsed/baseline ratio, floored at 1", () => {
    expect(slowdownFactor(100, 25)).toBe(4);
    expect(slowdownFactor(10, 25)).toBe(1);
  });

  test("treats unusable inputs as no slowdown", () => {
    expect(slowdownFactor(Number.NaN, 25)).toBe(1);
    expect(slowdownFactor(50, 0)).toBe(1);
    expect(slowdownFactor(-5, 25)).toBe(1);
  });
});

describe("calibration samples", () => {
  test("round-trip through the TSV line format and sanitize label separators", () => {
    const line = formatCalibrationSample({
      label: "unit shard 0\tattempt 1\nstart",
      elapsedMs: 61.234,
      baselineMs: 25,
    });
    expect(line).toBe("unit shard 0 attempt 1 start\t61.23\t25\n");
    expect(parseCalibrationSamples(line)).toEqual([
      { label: "unit shard 0 attempt 1 start", elapsedMs: 61.23, baselineMs: 25 },
    ]);
  });

  test("skip truncated and malformed lines", () => {
    const samples = parseCalibrationSamples("a\t30\t25\nb\t40\nc\tfast\t25\nd\t30\t0\n\ne\t75\t25");
    expect(samples.map((sample) => sample.label)).toEqual(["a", "e"]);
  });

  test("maxSlowdown takes the worst sample and is null without samples", () => {
    expect(maxSlowdown([])).toBeNull();
    expect(
      maxSlowdown([
        { label: "start", elapsedMs: 30, baselineMs: 25 },
        { label: "end", elapsedMs: 75, baselineMs: 25 },
      ]),
    ).toBe(3);
  });

  test("shardSlowdowns scopes each shard to its final attempt and ignores other labels", () => {
    const slowdowns = shardSlowdowns([
      { label: "unit shard 0 attempt 1 start", elapsedMs: 100, baselineMs: 25 },
      { label: "unit shard 0 attempt 2 start", elapsedMs: 30, baselineMs: 25 },
      { label: "unit shard 0 attempt 2 end", elapsedMs: 50, baselineMs: 25 },
      { label: "unit shard 1 attempt 1 end", elapsedMs: 10, baselineMs: 25 },
      { label: "changed shard 2 attempt 1 start", elapsedMs: 75, baselineMs: 25 },
      { label: "start", elapsedMs: 999, baselineMs: 25 },
    ]);
    expect(Object.fromEntries(slowdowns)).toEqual({
      "shard-0": 2,
      "shard-1": 1,
      "changed-shard-2": 3,
    });
  });

  test("readCalibrationDirectory reads only calibration TSV files", () => {
    const directory = mkdtempSync(join(tmpdir(), "runner-calibration-"));
    try {
      writeFileSync(join(directory, "calibration-shard-0.tsv"), "s0 start\t20\t25\n");
      writeFileSync(join(directory, "calibration-shard-1.tsv"), "s1 end\t100\t25\n");
      writeFileSync(join(directory, "shard-0.xml"), "x\t999\t1\n");
      expect(maxSlowdown(readCalibrationDirectory(directory))).toBe(4);
      expect(readCalibrationDirectory(join(directory, "missing"))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("positiveNumberFromEnv", () => {
  test("falls back when unset and rejects non-positive values", () => {
    expect(positiveNumberFromEnv(undefined, 25)).toBe(25);
    expect(positiveNumberFromEnv("", 25)).toBe(25);
    expect(positiveNumberFromEnv("40.5", 25)).toBe(40.5);
    expect(() => positiveNumberFromEnv("0", 25)).toThrow("positive number");
    expect(() => positiveNumberFromEnv("abc", 25)).toThrow("positive number");
  });
});
