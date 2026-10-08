import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runner calibration probe for the Node unit lane (#10583).
 *
 * Each unit shard runs this tiny fixed workload when it starts and when it
 * ends: a number of real event-loop turns plus a fixed integer loop, repeated
 * a few times with the FASTEST repetition recorded (a single GC pause or JIT
 * tier-up must not read as a starved runner; real starvation lasts seconds and
 * slows every repetition). One repetition takes about 12 ms on an Apple M3 Max;
 * the 25 ms baseline leaves headroom for slower-but-healthy CI cores, so the
 * slowdown under-reports rather than loosening the budget on a healthy runner.
 * On a starved runner the same work takes several times longer. The ratio (the
 * "slowdown") lets the 100 ms per-test timing gate tell a slow test apart from
 * a slow runner.
 *
 * Samples are appended as tab-separated lines (`label`, `elapsedMs`,
 * `baselineMs`) to `calibration-*.tsv` files next to the shard JUnit reports,
 * so the separate timing-budget job reads them from the same artifact.
 */

/** Expected fastest-repetition duration on an unloaded CI runner. */
export const DEFAULT_BASELINE_MS = 25;
export const DEFAULT_EVENT_LOOP_TURNS = 300;
export const DEFAULT_ARITHMETIC_ITERATIONS = 6_000_000;
export const DEFAULT_REPETITIONS = 3;
export const CALIBRATION_FILE_PATTERN = /^calibration-.*\.tsv$/;

export interface CalibrationClock {
  now(): number;
}

export interface CalibrationScheduler {
  /** Resolves after one real event-loop turn. */
  yieldTurn(): Promise<void>;
}

export interface CalibrationWorkload {
  turns: number;
  iterations: number;
  repetitions: number;
}

export interface CalibrationResult {
  elapsedMs: number;
  /** Consumed so the arithmetic loop cannot be optimised away. */
  checksum: number;
}

export interface CalibrationSample {
  label: string;
  elapsedMs: number;
  baselineMs: number;
}

export const realClock: CalibrationClock = { now: () => performance.now() };

export const realScheduler: CalibrationScheduler = {
  yieldTurn: () => new Promise<void>((resolve) => setImmediate(resolve)),
};

/** A fixed xorshift loop: pure CPU, no allocation, deterministic result. */
export function arithmeticWork(iterations: number): number {
  let state = 0x9e3779b9;
  for (let index = 0; index < iterations; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
  }
  return state >>> 0;
}

export async function runCalibrationProbe(
  clock: CalibrationClock,
  scheduler: CalibrationScheduler,
  workload: CalibrationWorkload,
): Promise<CalibrationResult> {
  let fastestMs = Number.POSITIVE_INFINITY;
  let checksum = 0;
  for (let repetition = 0; repetition < Math.max(1, workload.repetitions); repetition += 1) {
    const startedAt = clock.now();
    for (let turn = 0; turn < workload.turns; turn += 1) {
      await scheduler.yieldTurn();
    }
    checksum = arithmeticWork(workload.iterations);
    fastestMs = Math.min(fastestMs, clock.now() - startedAt);
  }
  return { elapsedMs: fastestMs, checksum };
}

/** Slowdown relative to the baseline, never below 1 (a fast runner is not "negative load"). */
export function slowdownFactor(elapsedMs: number, baselineMs: number): number {
  if (!(baselineMs > 0) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 1;
  }
  return Math.max(1, elapsedMs / baselineMs);
}

export function formatCalibrationSample(sample: CalibrationSample): string {
  const label = sample.label.replace(/[\t\r\n]/g, " ");
  return `${label}\t${sample.elapsedMs.toFixed(2)}\t${sample.baselineMs}\n`;
}

/** Parses calibration lines; a kill can truncate the last line, so malformed lines are skipped. */
export function parseCalibrationSamples(text: string): CalibrationSample[] {
  return text.split("\n").flatMap((line) => {
    const fields = line.split("\t");
    if (fields.length !== 3) {
      return [];
    }
    const elapsedMs = Number(fields[1]);
    const baselineMs = Number(fields[2]);
    if (!Number.isFinite(elapsedMs) || !Number.isFinite(baselineMs) || baselineMs <= 0) {
      return [];
    }
    return [{ label: fields[0], elapsedMs, baselineMs }];
  });
}

/** The worst slowdown across samples, or null when there is no usable sample. */
export function maxSlowdown(samples: readonly CalibrationSample[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  return Math.max(...samples.map((sample) => slowdownFactor(sample.elapsedMs, sample.baselineMs)));
}

const SHARD_LABEL_PATTERN = /^(unit|changed) shard (\d+) attempt (\d+) (?:start|end)$/;

/**
 * Worst slowdown per shard report key (`shard-N` for the unit lane,
 * `changed-shard-N` for the changed lane), using only the shard's FINAL
 * attempt: a discarded attempt-1 probe describes a report that was deleted, and
 * another shard's starvation says nothing about this shard's first samples.
 * Samples whose label is not a shard label are ignored.
 */
export function shardSlowdowns(samples: readonly CalibrationSample[]): Map<string, number> {
  const finalAttempt = new Map<string, number>();
  const parsed = samples.flatMap((sample) => {
    const match = SHARD_LABEL_PATTERN.exec(sample.label);
    if (!match) {
      return [];
    }
    const key = match[1] === "unit" ? `shard-${match[2]}` : `changed-shard-${match[2]}`;
    const attempt = Number(match[3]);
    finalAttempt.set(key, Math.max(attempt, finalAttempt.get(key) ?? 0));
    return [{ key, attempt, slowdown: slowdownFactor(sample.elapsedMs, sample.baselineMs) }];
  });
  const result = new Map<string, number>();
  for (const { key, attempt, slowdown } of parsed) {
    if (attempt === finalAttempt.get(key)) {
      result.set(key, Math.max(slowdown, result.get(key) ?? 1));
    }
  }
  return result;
}

export function readCalibrationDirectory(directory: string): CalibrationSample[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => CALIBRATION_FILE_PATTERN.test(name))
    .sort()
    .flatMap((name) => parseCalibrationSamples(readFileSync(join(directory, name), "utf8")));
}

/** Reads a positive number from the environment, falling back when unset or invalid. */
export function positiveNumberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, got '${value}'.`);
  }
  return parsed;
}

const USAGE =
  "Usage: bun scripts/lib/runner-calibration.ts probe <out.tsv> <label>\n" +
  "       bun scripts/lib/runner-calibration.ts slowdown <report-dir>\n" +
  "       bun scripts/lib/runner-calibration.ts shard-slowdowns <report-dir>";

async function main(args: string[]): Promise<void> {
  const [mode, target, label] = args;
  if (mode === "probe" && target && label) {
    const baselineMs = positiveNumberFromEnv(
      process.env.AUTOMOBILE_RUNNER_CALIBRATION_BASELINE_MS,
      DEFAULT_BASELINE_MS,
    );
    const result = await runCalibrationProbe(realClock, realScheduler, {
      turns: DEFAULT_EVENT_LOOP_TURNS,
      iterations: DEFAULT_ARITHMETIC_ITERATIONS,
      repetitions: DEFAULT_REPETITIONS,
    });
    const sample = { label, elapsedMs: result.elapsedMs, baselineMs };
    appendFileSync(target, formatCalibrationSample(sample));
    console.log(
      `runner calibration: ${label} took ${result.elapsedMs.toFixed(1)}ms ` +
        `(baseline ${baselineMs}ms, slowdown ${slowdownFactor(result.elapsedMs, baselineMs).toFixed(2)}x, checksum ${result.checksum})`,
    );
    return;
  }
  if (mode === "slowdown" && target) {
    const slowdown = maxSlowdown(readCalibrationDirectory(target));
    // No samples prints nothing: the caller treats that as "no calibration".
    if (slowdown !== null) {
      console.log(slowdown.toFixed(2));
    }
    return;
  }
  if (mode === "shard-slowdowns" && target) {
    // One `<report key>\t<slowdown>` line per shard; the gate scopes budgets by it.
    for (const [key, slowdown] of shardSlowdowns(readCalibrationDirectory(target))) {
      console.log(`${key}\t${slowdown.toFixed(2)}`);
    }
    return;
  }
  throw new Error(USAGE);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
