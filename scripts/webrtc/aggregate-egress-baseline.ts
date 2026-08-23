#!/usr/bin/env bun

/**
 * Aggregate accumulated WebRTC device-lane `stage-latency.json` records into a
 * p50/p95 egress / decoded-fps / stage-latency baseline (#4387).
 *
 * The device integration lane writes one `CaptureStageRecord` (schemaVersion 3)
 * per run as an artifact. #4375's follow-up needs "several CI runs accumulated,
 * then p50/p95 reported" before the `0.1` bpp budget or any timeout contract is
 * tightened — a measurement-collection task. This script is the *reporting* half
 * of that task: download the artifacts into one directory, point this at it, and
 * it computes the percentiles the decision turns on. It does not set or commit a
 * baseline number and does not change any encoder default.
 *
 * Usage:
 *   bun scripts/webrtc/aggregate-egress-baseline.ts <artifacts-dir> [platform]
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  aggregateCaptureStageRecords,
  formatCaptureBaselineSummary,
  type CaptureBaselineSummary,
  type CaptureStageRecord,
} from "../../test/helpers/captureStageTimeline";

/** Structural check that a parsed JSON value is a capture-stage record, not some other artifact JSON. */
function isCaptureStageRecord(value: unknown): value is CaptureStageRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.schemaVersion === "number" &&
    typeof candidate.platform === "string" &&
    Array.isArray(candidate.stages)
  );
}

/** List every `*.json` file under `dir`, recursing into per-run artifact subdirectories. */
async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Read every capture-stage record under `dir` (recursively). Files that are not
 * JSON, or JSON that is not a capture-stage record, are skipped with a warning
 * rather than failing the run — an artifact directory holds logs and unrelated
 * JSON alongside the record.
 */
export async function readCaptureStageRecords(dir: string): Promise<CaptureStageRecord[]> {
  const records: CaptureStageRecord[] = [];
  for (const file of await listJsonFiles(dir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      // Not JSON, or malformed JSON — an artifact directory mixes logs in; skip it.
      process.stderr.write(
        `skipping ${file}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      continue;
    }
    if (isCaptureStageRecord(parsed)) {
      records.push(parsed);
    }
  }
  return records;
}

/** Read the records under `dir` and reduce them to a p50/p95 baseline summary. */
export async function summarizeBaselineFromDir(
  dir: string,
  options: { platform?: string } = {},
): Promise<CaptureBaselineSummary> {
  const records = await readCaptureStageRecords(dir);
  return aggregateCaptureStageRecords(records, options);
}

async function main(): Promise<void> {
  const [dir, platform] = process.argv.slice(2);
  if (!dir) {
    throw new Error(
      "Usage: bun scripts/webrtc/aggregate-egress-baseline.ts <artifacts-dir> [platform]",
    );
  }
  const summary = await summarizeBaselineFromDir(dir, platform ? { platform } : {});
  process.stdout.write(`${formatCaptureBaselineSummary(summary)}\n`);
}

if (import.meta.main) {
  await main();
}
