import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  DEFAULT_HEAP_GROWTH_LIMIT_MB,
  buildLeakReport,
  buildSnapshotPath,
  parseMemoryLeakArgs,
  sanitizeSnapshotLabel,
  writeHeapSnapshotSafe,
  type HeapSnapshotDeps,
  type LeakReportConfig,
} from "../../scripts/memory/memory-leak-report";

describe("parseMemoryLeakArgs", () => {
  test("returns durable defaults when no flags are passed", () => {
    const args = parseMemoryLeakArgs([]);
    expect(args.heapGrowthLimitMb).toBe(DEFAULT_HEAP_GROWTH_LIMIT_MB);
    expect(args.mode).toBe("strict");
    expect(args.failOnLeak).toBe(true);
    expect(args.snapshotDir).toBe(process.cwd());
  });

  test("parses explicit flag values", () => {
    const args = parseMemoryLeakArgs([
      "--heap-growth-limit-mb",
      "25",
      "--snapshot-dir",
      "/tmp/snaps",
      "--output",
      "/tmp/report.json",
    ]);
    expect(args.heapGrowthLimitMb).toBe(25);
    expect(args.snapshotDir).toBe("/tmp/snaps");
    expect(args.outputPath).toBe("/tmp/report.json");
  });

  test("profile mode disables fail-on-leak", () => {
    const args = parseMemoryLeakArgs(["--mode", "profile"]);
    expect(args.mode).toBe("profile");
    expect(args.failOnLeak).toBe(false);
  });

  test("--no-fail disables failure", () => {
    expect(parseMemoryLeakArgs(["--no-fail"]).failOnLeak).toBe(false);
  });
});

describe("sanitizeSnapshotLabel / buildSnapshotPath", () => {
  test("replaces unsafe characters and caps length", () => {
    expect(sanitizeSnapshotLabel("memwatch leak!! 2026/06")).toBe("memwatch_leak_2026_06");
    expect(sanitizeSnapshotLabel("x".repeat(60))).toHaveLength(40);
  });

  test("builds a deterministic snapshot path with .heapsnapshot extension", () => {
    const p = buildSnapshotPath("/snaps", "threshold", 1700000000000);
    expect(p).toBe(path.join("/snaps", "heap-threshold-1700000000000.heapsnapshot"));
  });
});

describe("writeHeapSnapshotSafe", () => {
  function deps(overrides: Partial<HeapSnapshotDeps> = {}): {
    deps: HeapSnapshotDeps;
    errors: string[];
    mkdirCalls: string[];
    snapshotCalls: string[];
  } {
    const errors: string[] = [];
    const mkdirCalls: string[] = [];
    const snapshotCalls: string[] = [];
    return {
      errors,
      mkdirCalls,
      snapshotCalls,
      deps: {
        now: () => 42,
        mkdir: async (dir: string) => {
          mkdirCalls.push(dir);
        },
        writeHeapSnapshot: (filename: string) => {
          snapshotCalls.push(filename);
          return filename;
        },
        logger: {
          error: (msg?: unknown) => {
            errors.push(String(msg));
          },
        },
        ...overrides,
      },
    };
  }

  test("writes via the injected node:v8 writeHeapSnapshot and returns the path", async () => {
    const ctx = deps();
    const expectedPath = path.join("/snaps", "heap-threshold-42.heapsnapshot");
    const result = await writeHeapSnapshotSafe(ctx.deps, "/snaps", "threshold");
    expect(result).toBe(expectedPath);
    expect(ctx.mkdirCalls).toEqual(["/snaps"]);
    expect(ctx.snapshotCalls).toEqual([expectedPath]);
    expect(ctx.errors.some((e) => e.includes("Heap snapshot saved"))).toBe(true);
  });

  test("returns null and logs when writeHeapSnapshot throws (graceful fallback)", async () => {
    const ctx = deps({
      writeHeapSnapshot: () => {
        throw new Error("v8 unavailable");
      },
    });
    const result = await writeHeapSnapshotSafe(ctx.deps, "/snaps", "error");
    expect(result).toBeNull();
    expect(ctx.errors.some((e) => e.includes("Failed to write heap snapshot"))).toBe(true);
  });

  test("returns null when mkdir fails, without throwing", async () => {
    const ctx = deps({
      mkdir: async () => {
        throw new Error("EACCES");
      },
    });
    const result = await writeHeapSnapshotSafe(ctx.deps, "/snaps", "threshold");
    expect(result).toBeNull();
  });
});

describe("buildLeakReport", () => {
  const config: LeakReportConfig = {
    iterations: 100,
    opsPerSecond: 0,
    operations: ["observe", "tapOn"],
    heapGrowthLimitMb: 50,
    warmupIterations: 10,
    gcEvery: 0,
  };

  test("passes when heap growth is within the limit", () => {
    const report = buildLeakReport({
      timestamp: "2026-06-30T00:00:00.000Z",
      config,
      heapGrowthLimitBytes: 50 * 1024 * 1024,
      durationMs: 1234,
      operationCounts: { observe: 50, tapOn: 50, swipeOn: 0, inputText: 0 },
      heapUsedStart: 1000,
      heapUsedEnd: 2000,
    });
    expect(report.passed).toBe(true);
    expect(report.results.heapGrowthBytes).toBe(1000);
    expect(report.results.effectiveGrowthBytes).toBe(1000);
  });

  test("fails when heap growth exceeds the limit", () => {
    const report = buildLeakReport({
      timestamp: "2026-06-30T00:00:00.000Z",
      config,
      heapGrowthLimitBytes: 500,
      durationMs: 1,
      operationCounts: { observe: 1, tapOn: 0, swipeOn: 0, inputText: 0 },
      heapUsedStart: 1000,
      heapUsedEnd: 2000,
    });
    expect(report.passed).toBe(false);
  });

  test("clamps negative heap growth to zero (GC freed memory)", () => {
    const report = buildLeakReport({
      timestamp: "2026-06-30T00:00:00.000Z",
      config,
      heapGrowthLimitBytes: 500,
      durationMs: 1,
      operationCounts: { observe: 1, tapOn: 0, swipeOn: 0, inputText: 0 },
      heapUsedStart: 5000,
      heapUsedEnd: 2000,
    });
    expect(report.results.heapGrowthBytes).toBe(-3000);
    expect(report.results.effectiveGrowthBytes).toBe(0);
    expect(report.passed).toBe(true);
  });
});
