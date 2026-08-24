import path from "node:path";
import type { StressOperation } from "./stress-harness";

export interface MemoryLeakArgs {
  heapGrowthLimitMb: number;
  outputPath?: string;
  snapshotDir: string;
  mode: "strict" | "profile";
  failOnLeak: boolean;
}

export const DEFAULT_HEAP_GROWTH_LIMIT_MB = 50;

/**
 * Parse the memory-leak-specific CLI flags. Stress flags are parsed separately
 * by {@link parseStressArgs}; the two share the same argv.
 */
export function parseMemoryLeakArgs(argv: string[]): MemoryLeakArgs {
  const args: MemoryLeakArgs = {
    heapGrowthLimitMb: DEFAULT_HEAP_GROWTH_LIMIT_MB,
    snapshotDir: process.cwd(),
    mode: "strict",
    failOnLeak: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--heap-growth-limit-mb") {
      args.heapGrowthLimitMb = Number.parseFloat(next);
      i++;
      continue;
    }

    if (arg === "--output") {
      args.outputPath = next;
      i++;
      continue;
    }

    if (arg === "--snapshot-dir") {
      args.snapshotDir = next;
      i++;
      continue;
    }

    if (arg === "--mode") {
      args.mode = next === "profile" ? "profile" : "strict";
      i++;
      continue;
    }

    if (arg === "--no-fail") {
      args.failOnLeak = false;
      continue;
    }
  }

  if (args.mode === "profile") {
    args.failOnLeak = false;
  }

  return args;
}

/** Make a label safe to embed in a heap snapshot filename. */
export function sanitizeSnapshotLabel(label: string): string {
  return label.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40);
}

/** Build the absolute heap snapshot path for a label at a given time. */
export function buildSnapshotPath(snapshotDir: string, label: string, now: number): string {
  return path.join(snapshotDir, `heap-${sanitizeSnapshotLabel(label)}-${now}.heapsnapshot`);
}

/**
 * Dependencies for writing a heap snapshot, injected so the durable behavior
 * (graceful fallback, logging) can be unit-tested without touching disk or
 * Node/Bun internals.
 */
export interface HeapSnapshotDeps {
  /** Built-in `node:v8` writeHeapSnapshot; writes to `filename` and returns it. */
  writeHeapSnapshot: (filename: string) => string;
  mkdir: (dir: string) => Promise<unknown>;
  now: () => number;
  logger: Pick<typeof console, "error">;
}

/**
 * Write a heap snapshot for `label` into `snapshotDir`, returning the written
 * path or `null` on any failure. Never throws — heap snapshots are a best-effort
 * diagnostic, so the stress run must continue even when snapshotting fails.
 */
export async function writeHeapSnapshotSafe(
  deps: HeapSnapshotDeps,
  snapshotDir: string,
  label: string,
): Promise<string | null> {
  const filePath = buildSnapshotPath(snapshotDir, label, deps.now());
  try {
    await deps.mkdir(snapshotDir);
    const filename = deps.writeHeapSnapshot(filePath);
    deps.logger.error(`[memory-leaks] Heap snapshot saved: ${filename}`);
    return filename;
  } catch (error) {
    deps.logger.error(`[memory-leaks] Failed to write heap snapshot: ${error}`);
    return null;
  }
}

export interface LeakReportConfig {
  iterations: number;
  opsPerSecond: number;
  operations: StressOperation[];
  heapGrowthLimitMb: number;
  warmupIterations: number;
  gcEvery: number;
}

export interface LeakReportInput {
  timestamp: string;
  config: LeakReportConfig;
  heapGrowthLimitBytes: number;
  durationMs: number;
  operationCounts: Record<StressOperation, number>;
  heapUsedStart: number;
  heapUsedEnd: number;
}

export interface LeakReport {
  timestamp: string;
  passed: boolean;
  config: LeakReportConfig;
  results: {
    durationMs: number;
    operationCounts: Record<StressOperation, number>;
    heapUsedStart: number;
    heapUsedEnd: number;
    heapGrowthBytes: number;
    effectiveGrowthBytes: number;
  };
}

/**
 * Compute the leak report from start/end heap usage. Detection is purely a
 * heap-growth threshold now that the native `memwatch-next` addon is gone; the
 * built-in `process.memoryUsage()` delta is the durable, addon-free signal.
 */
export function buildLeakReport(input: LeakReportInput): LeakReport {
  const heapGrowth = input.heapUsedEnd - input.heapUsedStart;
  const effectiveGrowth = Math.max(heapGrowth, 0);
  const passed = effectiveGrowth <= input.heapGrowthLimitBytes;

  return {
    timestamp: input.timestamp,
    passed,
    config: input.config,
    results: {
      durationMs: input.durationMs,
      operationCounts: input.operationCounts,
      heapUsedStart: input.heapUsedStart,
      heapUsedEnd: input.heapUsedEnd,
      heapGrowthBytes: heapGrowth,
      effectiveGrowthBytes: effectiveGrowth,
    },
  };
}
