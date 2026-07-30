#!/usr/bin/env bun

/**
 * Android video-server throughput/latency baseline gate (#4758).
 *
 * Reads the device lane's accumulated `stage-latency.json` records out of an
 * artifacts directory, reduces the Android samples to p50/p95, and fails the
 * process when any metric regressed past the tolerance committed in
 * `benchmark/webrtc/android-video-baseline.json` — the ratchet the fps/VBR/GOP
 * tuning issues gate on. This is the Android counterpart to the iOS *reporting*
 * script (`aggregate-egress-baseline.ts`, #4387); unlike that reporting-only
 * tool, this one exits non-zero on regression, mirroring the typecheck/lint
 * baseline gates.
 *
 * Usage:
 *   bun scripts/webrtc/android-video-baseline-gate.ts <artifacts-dir> [baseline.json]
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readCaptureStageRecords } from "./aggregate-egress-baseline";
import {
  evaluateAndroidVideoBaseline,
  extractAndroidVideoMetrics,
  formatAndroidVideoGateResult,
  isAndroidVideoBaseline,
  type AndroidVideoBaseline,
} from "../../test/helpers/androidVideoBaseline";

const DEFAULT_BASELINE_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "benchmark",
  "webrtc",
  "android-video-baseline.json"
);

/** Read and structurally validate the committed baseline JSON. */
export async function readAndroidVideoBaseline(file: string): Promise<AndroidVideoBaseline> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read Android video baseline at ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isAndroidVideoBaseline(parsed)) {
    throw new Error(`Malformed Android video baseline at ${file}: missing required version/fpsTarget/metrics fields`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const [dir, baselinePath] = process.argv.slice(2);
  if (!dir) {
    throw new Error("Usage: bun scripts/webrtc/android-video-baseline-gate.ts <artifacts-dir> [baseline.json]");
  }
  const baseline = await readAndroidVideoBaseline(baselinePath ?? DEFAULT_BASELINE_PATH);
  const records = await readCaptureStageRecords(dir);
  const metrics = extractAndroidVideoMetrics(records);
  const result = evaluateAndroidVideoBaseline(metrics, baseline);
  process.stdout.write(`${formatAndroidVideoGateResult(result)}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
