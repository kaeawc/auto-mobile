/**
 * Benchmark: overhead + window sizing for the opt-in observe `perfSnapshot`
 * (issue #5077).
 *
 * Drives a fast navigation loop across several heavy Android system screens
 * (Settings panels with long scrollable lists), issuing back-to-back `observe`
 * calls, and compares:
 *   - flag OFF (baseline observe wall-clock)
 *   - flag ON across window sizes {1000, 2000, 5000, 10000, 30000} ms
 *
 * Reports, per cell: observe wall-clock median/p95, the delta vs the OFF
 * baseline (the feature's real-world overhead), and — for ON cells — the
 * snapshot's fps percentiles, `sampleCount`, and the run-to-run stability
 * (stdev of fps.p50) so the jitter-vs-smoothing tradeoff across windows is
 * visible. A separate micro-benchmark isolates `PerfWindowBuffer.snapshot()`
 * compute cost as the window (and thus sample count) grows.
 *
 * Requires a booted Android device/emulator reachable over adb with the
 * AutoMobile CtrlProxy running. Run:
 *   BENCH_DEVICE_ID=emulator-5554 bun run benchmark/perf-snapshot-overhead.ts
 */

import { RealObserveScreen } from "../src/features/observe/ObserveScreen";
import { defaultAdbClientFactory } from "../src/utils/android-cmdline-tools/AdbClientFactory";
import { getPerfWindowBuffer, PerfWindowBuffer, PerfSample } from "../src/features/performance/PerfWindowBuffer";
import { PerformanceMonitor, PerformanceDataPusher } from "../src/features/performance/PerformanceMonitor";
import type { LivePerformanceData } from "../src/daemon/performancePushSocketServer";
import type { BootedDevice } from "../src/models";
import { writeFileSync } from "fs";

/**
 * No-op pusher. The real sampler skips sampling entirely when its server getter
 * returns null, so we give it a sink. We only care about the side effect —
 * `PerformanceMonitor.pushMetrics` records every sample into the shared
 * `getPerfWindowBuffer()` singleton that `observe` reads.
 */
class NoOpPusher implements PerformanceDataPusher {
  pushPerformanceData(_data: LivePerformanceData): void {}
}

const ENABLE_ENV = "AUTOMOBILE_OBSERVE_PERF_SNAPSHOT";
const WINDOW_ENV = "AUTOMOBILE_OBSERVE_PERF_WINDOW_MS";

const deviceId = process.env.BENCH_DEVICE_ID ?? "emulator-5554";
const iterations = Number(process.env.BENCH_ITERS ?? 30);
const warmup = Number(process.env.BENCH_WARMUP ?? 8);
// Paired OFF/ON trials repeated this many times, ON windows alternating
// direction each pass, to counterbalance execution-order drift.
const repeats = Math.max(1, Number(process.env.BENCH_REPEATS ?? 1));
// Only the supported window range (matching observePerfSnapshotConfig's clamp),
// so a cell label can't advertise a window the production config would reject.
const WINDOW_MIN = 1000;
const WINDOW_MAX = 30000;
const windows = (process.env.BENCH_WINDOWS ?? "1000,2000,5000,10000,30000")
  .split(",")
  .map(s => Number(s.trim()))
  .filter(n => Number.isInteger(n) && n >= WINDOW_MIN && n <= WINDOW_MAX);
if (windows.length === 0) {
  throw new Error(`BENCH_WINDOWS must list integers in [${WINDOW_MIN}, ${WINDOW_MAX}]ms`);
}

const device: BootedDevice = { deviceId, name: deviceId, platform: "android" };
const adb = defaultAdbClientFactory.create(device);

/** Public Settings intent actions — stable across API levels, all heavy lists. */
const HEAVY_SCREENS = [
  "android.settings.SETTINGS",
  "android.settings.APPLICATION_SETTINGS",
  "android.settings.WIFI_SETTINGS",
  "android.settings.DISPLAY_SETTINGS",
  "android.settings.SOUND_SETTINGS",
];

// Bun.sleep avoids a raw setTimeout (repo's no-raw-timer rule) without needing
// the injectable Timer seam — this is a throwaway benchmark process.
const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function launchScreen(action: string): Promise<void> {
  await adb.executeCommand(`shell am start -a ${action}`);
  await sleep(900);
}

async function scroll(down: boolean): Promise<void> {
  const [y1, y2] = down ? [1500, 600] : [600, 1500];
  // 120ms swipe → a real fling that renders frames the sampler can see.
  await adb.executeCommand(`shell input swipe 540 ${y1} 540 ${y2} 120`);
}

// ---- stats helpers ------------------------------------------------------

function sortedCopy(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) { return 0; }
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function median(xs: number[]): number { return percentile(sortedCopy(xs), 50); }
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stdev(xs: number[]): number {
  if (xs.length < 2) { return 0; }
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---- navigation loop ----------------------------------------------------

let navCounter = 0;
/** Advance the "fast heavy-screen navigation": relaunch a panel every few
 *  steps, otherwise fling-scroll the current one. */
async function navigateStep(): Promise<void> {
  if (navCounter % 4 === 0) {
    await launchScreen(HEAVY_SCREENS[(navCounter / 4) % HEAVY_SCREENS.length]);
  } else {
    await scroll(navCounter % 2 === 0);
  }
  navCounter += 1;
}

// ---- one matrix cell ----------------------------------------------------

interface CellResult {
  /** 0-based execution order across the whole run (records the counterbalancing). */
  order: number;
  label: string;
  enabled: boolean;
  windowMs: number | null;
  observeMs: number[];
  fpsP50Samples: number[];
  lastSnapshot: unknown | null;
}

function applyEnv(enabled: boolean, windowMs: number | null): void {
  if (enabled) {
    process.env[ENABLE_ENV] = "1";
    if (windowMs !== null) { process.env[WINDOW_ENV] = String(windowMs); }
  } else {
    delete process.env[ENABLE_ENV];
    delete process.env[WINDOW_ENV];
  }
}

async function runCell(
  order: number,
  label: string,
  enabled: boolean,
  windowMs: number | null,
  sampler: PerformanceMonitor
): Promise<CellResult> {
  applyEnv(enabled, windowMs);
  // Reset retained samples so a cell's window reflects only its own run — every
  // ON cell re-registers the same device/package, so startMonitoring() would not
  // clear on its own and later cells would inherit earlier cells' samples.
  getPerfWindowBuffer().clear(deviceId);
  // OFF baseline runs with the sampler idle; ON cells run it concurrently
  // (monitoring the foreground Settings package) to capture its real load.
  if (enabled) {
    sampler.start();
    sampler.startMonitoring(deviceId, "com.android.settings", "android");
  } else {
    sampler.stopMonitoring(deviceId);
  }
  process.stdout.write(`\n▶ ${label} … `);

  // Warm-up: navigate + observe so the device settles and (when enabled) the
  // sampler window fills before we measure.
  for (let i = 0; i < warmup; i += 1) {
    await navigateStep();
    await new RealObserveScreen(device).execute();
  }

  const observeMs: number[] = [];
  const fpsP50Samples: number[] = [];
  let lastSnapshot: unknown | null = null;

  for (let i = 0; i < iterations; i += 1) {
    await navigateStep();
    const t0 = performance.now();
    const result = await new RealObserveScreen(device).execute();
    observeMs.push(performance.now() - t0);
    if (enabled && result.perfSnapshot) {
      lastSnapshot = result.perfSnapshot;
      if (result.perfSnapshot.fps) { fpsP50Samples.push(result.perfSnapshot.fps.p50); }
    }
  }
  process.stdout.write(`done (median ${r1(median(observeMs))}ms)`);
  return { order, label, enabled, windowMs, observeMs, fpsP50Samples, lastSnapshot };
}

// ---- pure snapshot() micro-benchmark ------------------------------------

interface MicroResult { windowMs: number; sampleCount: number; nsPerCall: number; }

function microBenchSnapshot(): MicroResult[] {
  const out: MicroResult[] = [];
  const CALLS = 5000;
  for (const windowMs of windows) {
    const buffer = new PerfWindowBuffer();
    const count = Math.min(PerfWindowBuffer.MAX_SAMPLES_PER_DEVICE, Math.floor(windowMs / 500));
    // Fill with synthetic samples spread evenly across the window.
    for (let i = 0; i < count; i += 1) {
      const s: PerfSample = {
        t: i * 500,
        fps: 40 + (i % 20),
        frameTimeMs: 16 + (i % 8),
        jankFrames: i % 3,
        touchLatencyMs: 16 + (i % 30),
        cpuUsagePercent: 10 + (i % 40),
        memoryUsageMb: 100 + (i % 60),
      };
      buffer.record("micro", s);
    }
    const now = count * 500;
    const t0 = performance.now();
    for (let c = 0; c < CALLS; c += 1) { buffer.snapshot("micro", now, windowMs); }
    const nsPerCall = ((performance.now() - t0) * 1e6) / CALLS;
    out.push({ windowMs, sampleCount: count, nsPerCall: Math.round(nsPerCall) });
  }
  return out;
}

// ---- reporting ----------------------------------------------------------

function report(cells: CellResult[], micro: MicroResult[]): void {
  const byOrder = new Map(cells.map(c => [c.order, c]));
  const offMedians = cells.filter(c => !c.enabled).map(c => median(c.observeMs));
  const offMedian = offMedians.length ? median(offMedians) : 0;

  console.log("\n\n=== observe wall-clock: paired OFF/ON, per-window (drift-counterbalanced) ===");
  console.log("iterations/cell:", iterations, " warmup:", warmup, " repeats:", repeats, " device:", deviceId);
  console.log(`OFF baseline median across ${offMedians.length} cell(s): ${r1(offMedian)}ms`);
  console.log("─".repeat(92));
  console.log(
    "window".padEnd(10), "ON median(ms)".padStart(13), "paired Δ".padStart(10), "Δ%".padStart(7),
    "fps p50/p95/p99".padStart(20), "samples".padStart(8), "fpsP50 σ".padStart(9)
  );
  console.log("─".repeat(92));
  for (const w of windows) {
    const on = cells.filter(c => c.enabled && c.windowMs === w);
    if (on.length === 0) { continue; }
    // Each ON cell's paired OFF is the cell run immediately before it.
    const pairedDeltas = on.map(c => median(c.observeMs) - median((byOrder.get(c.order - 1) ?? c).observeMs));
    const dMed = median(pairedDeltas);
    const onMed = median(on.flatMap(c => c.observeMs));
    const dPct = offMedian > 0 ? (dMed / offMedian) * 100 : 0;
    const last = on[on.length - 1].lastSnapshot as { fps?: { p50: number; p95: number; p99: number }; sampleCount?: number } | null;
    const fpsStr = last?.fps ? `${r1(last.fps.p50)}/${r1(last.fps.p95)}/${r1(last.fps.p99)}` : "—";
    const sigma = r2(stdev(on.flatMap(c => c.fpsP50Samples)));
    console.log(
      String(w).padEnd(10),
      r1(onMed).toString().padStart(13),
      r1(dMed).toString().padStart(10),
      r1(dPct).toString().padStart(7),
      fpsStr.padStart(20),
      (last?.sampleCount ?? 0).toString().padStart(8),
      sigma.toString().padStart(9)
    );
  }
  console.log("─".repeat(92));

  console.log("\n=== pure PerfWindowBuffer.snapshot() cost (device-independent) ===");
  console.log("window(ms)".padStart(11), "samples".padStart(9), "ns/call".padStart(10));
  console.log("─".repeat(34));
  for (const m of micro) {
    console.log(m.windowMs.toString().padStart(11), m.sampleCount.toString().padStart(9), m.nsPerCall.toString().padStart(10));
  }
  console.log("─".repeat(34));
}

// ---- main ---------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`perfSnapshot overhead benchmark — device ${deviceId}`);
  await launchScreen(HEAVY_SCREENS[0]);

  // Run our own sampler (feeding the shared buffer) the way the daemon's does,
  // so the 500ms dumpsys sampler runs concurrently with observe — the realistic
  // load the feature adds — and ON snapshots are actually populated. Started
  // only for the ON cells (see runCell), monitoring the foreground package.
  const sampler = new PerformanceMonitor(undefined, defaultAdbClientFactory, () => new NoOpPusher());

  // Global warm-up so the very first paired OFF baseline isn't measured cold
  // (cold-start observe latency would otherwise skew that pair's delta).
  process.stdout.write("warming up … ");
  for (let i = 0; i < warmup; i += 1) {
    await navigateStep();
    await new RealObserveScreen(device).execute();
  }
  process.stdout.write("done");

  // Counterbalanced matrix: each ON window is measured against a FRESH OFF
  // baseline run immediately before it (paired), so slow drift — thermal state,
  // caches, navCounter — largely cancels in the per-window delta rather than
  // masquerading as a window-size effect. The whole matrix repeats `repeats`
  // times with the ON windows alternating direction each pass, and every cell's
  // execution `order` is recorded so the raw output shows the interleaving.
  const cells: CellResult[] = [];
  let order = 0;
  for (let rep = 0; rep < repeats; rep += 1) {
    const pass = rep % 2 === 0 ? windows : [...windows].reverse();
    for (const w of pass) {
      cells.push(await runCell(order++, "OFF", false, null, sampler));
      cells.push(await runCell(order++, `ON@${w}`, true, w, sampler));
    }
  }
  sampler.stop();

  const micro = microBenchSnapshot();
  report(cells, micro);

  const outPath = process.env.BENCH_OUT ?? "scratch/perf-snapshot-benchmark.json";
  try {
    writeFileSync(outPath, JSON.stringify({ deviceId, iterations, warmup, repeats, windows, cells, micro }, null, 2));
    console.log(`\nRaw results → ${outPath}`);
  } catch {
    // scratch/ may not exist in every checkout; the console table is the primary output.
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error("benchmark failed:", e?.stack ?? e);
  process.exit(1);
});
