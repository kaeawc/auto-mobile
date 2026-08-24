import fs from "node:fs";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";
import {
  createStressHarness,
  parseStressArgs,
  resolveStressConfig,
  runStressOperations,
} from "./memory/stress-harness";
import {
  buildLeakReport,
  parseMemoryLeakArgs,
  writeHeapSnapshotSafe,
  type HeapSnapshotDeps,
} from "./memory/memory-leak-report";

// Heap snapshots and forced GC use Node/Bun built-ins only — the legacy
// `heapdump` and `memwatch-next` native addons were removed because they fail
// to compile against Node 26 / V8 headers and broke `bun install`.
const snapshotDeps: HeapSnapshotDeps = {
  writeHeapSnapshot,
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  now: () => Date.now(),
  logger: console,
};

async function main(): Promise<void> {
  if (typeof global.gc !== "function") {
    console.warn(
      "[memory-leaks] global.gc is unavailable; run with --expose-gc " +
        "(e.g. `bun --expose-gc scripts/detect-memory-leaks.ts`) for accurate heap measurements.",
    );
  }

  const argv = process.argv.slice(2);
  const stressArgs = parseStressArgs(argv);
  const { runConfig, warmupIterations } = resolveStressConfig(stressArgs);
  const leakArgs = parseMemoryLeakArgs(argv);
  const heapGrowthLimitBytes = leakArgs.heapGrowthLimitMb * 1024 * 1024;

  const harness = await createStressHarness();
  let snapshotPromise: Promise<string | null> | null = null;

  try {
    if (warmupIterations > 0) {
      await runStressOperations(harness, {
        ...runConfig,
        iterations: warmupIterations,
        gcEvery: 0,
      });
    }

    if (typeof global.gc === "function") {
      global.gc();
    }

    const startUsage = process.memoryUsage();
    const runResult = await runStressOperations(harness, runConfig);

    if (typeof global.gc === "function") {
      global.gc();
    }

    const endUsage = process.memoryUsage();

    const report = buildLeakReport({
      timestamp: new Date().toISOString(),
      config: {
        iterations: runConfig.iterations,
        opsPerSecond: runConfig.opsPerSecond,
        operations: runConfig.operations,
        heapGrowthLimitMb: leakArgs.heapGrowthLimitMb,
        warmupIterations,
        gcEvery: runConfig.gcEvery,
      },
      heapGrowthLimitBytes,
      durationMs: runResult.durationMs,
      operationCounts: runResult.operationCounts,
      heapUsedStart: startUsage.heapUsed,
      heapUsedEnd: endUsage.heapUsed,
    });

    if (leakArgs.outputPath) {
      await fs.promises.mkdir(path.dirname(leakArgs.outputPath), { recursive: true });
      await fs.promises.writeFile(leakArgs.outputPath, JSON.stringify(report, null, 2));
    }

    console.log("[memory-leaks] Stress run complete.");
    console.log(
      `[memory-leaks] Heap growth: ${(report.results.effectiveGrowthBytes / (1024 * 1024)).toFixed(2)} MB`,
    );

    if (!report.passed && leakArgs.failOnLeak) {
      snapshotPromise = writeHeapSnapshotSafe(snapshotDeps, leakArgs.snapshotDir, "threshold");
      await snapshotPromise;
      console.error("[memory-leaks] Memory leak detection failed.");
      process.exitCode = 1;
    } else {
      console.log("[memory-leaks] Memory leak detection passed.");
    }
  } catch (error) {
    console.error(`[memory-leaks] Unexpected error: ${error}`);
    if (!snapshotPromise) {
      snapshotPromise = writeHeapSnapshotSafe(snapshotDeps, leakArgs.snapshotDir, "error");
    }
    await snapshotPromise;
    process.exitCode = 1;
  } finally {
    await harness.cleanup();
  }
}

void main();
