export type ScreenshotMode = "async" | "settled" | "none";

export interface BenchmarkOptions {
  deviceId?: string;
  platform?: "android" | "ios";
  iterations: number;
  warmup: number;
  app?: string;
  json: boolean;
  serverPath?: string;
  help: boolean;
}

export interface Metrics {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  sampleSize: number;
  failures: number;
  screenshotSettledFalse: number;
}

export interface BenchmarkReport {
  platform: string;
  deviceId?: string;
  generatedAt: string;
  iterations: number;
  warmup: number;
  actionMode: "ambient default, not mode-controlled";
  results: Record<string, Record<string, Metrics>>;
  settledVsAsync: Record<string, { p50: number; p95: number; p99: number }>;
}

export function parseBenchmarkArgs(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = { iterations: 30, warmup: 3, json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--json") {
      options.json = true;
    } else if (
      ["--device", "--platform", "--iterations", "--warmup", "--app", "--server"].includes(flag)
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}.`);
      }
      if (flag === "--device") {
        options.deviceId = value;
      } else if (flag === "--platform") {
        if (value !== "android" && value !== "ios") {
          throw new Error("--platform must be android or ios.");
        }
        options.platform = value;
      } else if (flag === "--iterations" || flag === "--warmup") {
        const number = Number(value);
        if (!Number.isInteger(number) || number < (flag === "--iterations" ? 1 : 0)) {
          throw new Error(
            `${flag} must be ${flag === "--iterations" ? "a positive" : "a non-negative"} integer.`,
          );
        }
        if (flag === "--iterations") {
          options.iterations = number;
        } else {
          options.warmup = number;
        }
      } else if (flag === "--app") {
        options.app = value;
      } else {
        options.serverPath = value;
      }
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!options.help && !options.deviceId && !options.platform) {
    throw new Error("Specify a target with --device <id> or --platform android|ios.");
  }
  if (options.deviceId && options.platform) {
    throw new Error("Use --device or --platform, not both.");
  }
  return options;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((sorted.length * p) / 100) - 1)] ?? 0;
}

export function calculateMetrics(
  values: number[],
  failures: number,
  screenshotSettledFalse: number,
): Metrics {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    sampleSize: values.length,
    failures,
    screenshotSettledFalse,
  };
}

export function settledAsyncDelta(
  settled: Metrics,
  async: Metrics,
): { p50: number; p95: number; p99: number } {
  return {
    p50: settled.p50 - async.p50,
    p95: settled.p95 - async.p95,
    p99: settled.p99 - async.p99,
  };
}

export function formatReportJson(report: BenchmarkReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatReportTable(report: BenchmarkReport): string {
  const lines = [
    `Settled Screenshot Benchmark — ${report.platform}`,
    "Call             Mode      p50      p95      p99      min      max  n  failures  settled-false",
  ];
  for (const [kind, modes] of Object.entries(report.results)) {
    for (const [mode, metric] of Object.entries(modes)) {
      lines.push(
        `${kind.padEnd(16)} ${mode.padEnd(8)} ${metric.p50.toFixed(1).padStart(7)} ${metric.p95.toFixed(1).padStart(7)} ${metric.p99.toFixed(1).padStart(7)} ${metric.min.toFixed(1).padStart(7)} ${metric.max.toFixed(1).padStart(7)} ${String(metric.sampleSize).padStart(3)} ${String(metric.failures).padStart(9)} ${String(metric.screenshotSettledFalse).padStart(14)}`,
      );
    }
  }
  lines.push("Settled − async (ms):");
  for (const [kind, delta] of Object.entries(report.settledVsAsync)) {
    lines.push(
      `${kind}: p50 ${signed(delta.p50)}, p95 ${signed(delta.p95)}, p99 ${signed(delta.p99)}`,
    );
  }
  lines.push("pressButton mode: ambient default, not mode-controlled");
  return lines.join("\n");
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}ms`;
}

export function helpText(): string {
  return `Usage: bun scripts/benchmark-settled-screenshot.ts (--device <id> | --platform android|ios) [options]\n\nOptions: --iterations N (30) --warmup W (3) --app <bundleOrPackage> --server <path> --json --help\nThe action probe uses pressButton volume_up under the ambient default, not mode-controlled; direct observe calls exercise all modes.`;
}
