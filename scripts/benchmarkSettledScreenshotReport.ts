import { errorMessage } from "../src/utils/describeUnknownError";

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
  allowFailures: boolean;
}

export interface FailureReason {
  message: string;
  count: number;
}

interface CommonMetrics {
  sampleSize: number;
  failures: number;
  screenshotSettledFalse: number;
  failureReasons: FailureReason[];
}

export interface ValidMetrics extends CommonMetrics {
  invalid?: false;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

export interface InvalidMetrics extends CommonMetrics {
  invalid: true;
}

export type SeriesMetrics = ValidMetrics | InvalidMetrics;
export type Metrics = SeriesMetrics;

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
  const options: BenchmarkOptions = {
    iterations: 30,
    warmup: 3,
    json: false,
    help: false,
    allowFailures: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--json") {
      options.json = true;
    } else if (flag === "--allow-failures") {
      options.allowFailures = true;
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
  failureMessages: string[] = [],
): Metrics {
  const common: CommonMetrics = {
    sampleSize: values.length,
    failures,
    screenshotSettledFalse,
    failureReasons: aggregateFailureReasons(failureMessages),
  };
  if (isInvalidSeries(values.length, failures)) {
    return { ...common, invalid: true };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    ...common,
  };
}

export function settledAsyncDelta(
  settled: Metrics,
  async: Metrics,
): { p50: number; p95: number; p99: number } | undefined {
  if (settled.invalid || async.invalid) {
    return undefined;
  }
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
  const reasons: string[] = [];
  for (const [kind, modes] of Object.entries(report.results)) {
    for (const [mode, metric] of Object.entries(modes)) {
      const latency = metric.invalid
        ? "INVALID".padEnd(39)
        : [metric.p50, metric.p95, metric.p99, metric.min, metric.max]
            .map((value) => value.toFixed(1).padStart(7))
            .join(" ");
      lines.push(
        `${kind.padEnd(16)} ${mode.padEnd(8)} ${latency} ${String(metric.sampleSize).padStart(3)} ${String(metric.failures).padStart(9)} ${String(metric.screenshotSettledFalse).padStart(14)}`,
      );
      for (const reason of metric.failureReasons) {
        const singleLine = reason.message.replace(/\s+/g, " ").trim();
        const message = singleLine.length > 200 ? `${singleLine.slice(0, 199)}…` : singleLine;
        reasons.push(
          `${kind}/${mode} (${metric.failures}/${metric.sampleSize}): ${reason.count}x ${message}`,
        );
      }
    }
  }
  if (reasons.length > 0) {
    lines.push("Failure reasons:", ...reasons);
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
  return `Usage: bun scripts/benchmark-settled-screenshot.ts (--device <id> | --platform android|ios) [options]\n\nOptions: --iterations N (30) --warmup W (3) --app <bundleOrPackage> --server <path> --json --allow-failures --help\n--allow-failures permits exit zero when a series is INVALID (all calls failed).\nThe action probe uses pressButton volume_up under the ambient default, not mode-controlled; direct observe calls exercise all modes.`;
}

export function isInvalidSeries(sampleSize: number, failures: number): boolean {
  return sampleSize > 0 && failures === sampleSize;
}

export function invalidSeriesNames(report: BenchmarkReport): string[] {
  return Object.entries(report.results).flatMap(([kind, modes]) =>
    Object.entries(modes)
      .filter(([, metrics]) => metrics.invalid)
      .map(([mode]) => `${kind}/${mode}`),
  );
}

export function benchmarkExitCode(
  report: BenchmarkReport,
  options: { allowFailures: boolean },
): number {
  return !options.allowFailures && invalidSeriesNames(report).length > 0 ? 1 : 0;
}

export function aggregateFailureReasons(messages: string[]): FailureReason[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const normalized = message.trim() || "failed with no error message";
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts]
    .map(([message, count]) => ({ message, count }))
    .sort(
      (a, b) => b.count - a.count || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
    );
}

interface EnvelopeState {
  failed: boolean;
  payload?: Record<string, unknown>;
  texts: string[];
  parseError?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function envelopeState(envelope: unknown): EnvelopeState {
  const outer = record(envelope);
  const texts = Array.isArray(outer?.content)
    ? outer.content.flatMap((entry: unknown) => {
        const content = record(entry);
        return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
      })
    : [];
  let payload = record(outer?.structuredContent);
  let parseError: string | undefined;
  if (!payload && texts[0]?.trimStart().startsWith("{")) {
    try {
      payload = record(JSON.parse(texts[0]));
    } catch (error) {
      // Preserve the diagnostic for the shell to log; raw error text is still usable.
      parseError = errorMessage(error);
    }
  }
  return {
    failed: Boolean(outer?.isError || payload?.success === false || payload?.error),
    payload,
    texts,
    parseError,
  };
}

/**
 * Platform of `deviceId` in a `listDevices` payload, matched by runtime id, stable id or an
 * Android transport alias. Observe results carry no platform, so `--device` runs need this to
 * avoid reporting "unknown" (#8758).
 */
export function platformFromDeviceList(
  payload: Record<string, unknown> | undefined,
  deviceId: string,
): string | undefined {
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  const match = devices.map(record).find((device) => {
    const aliases = Array.isArray(device?.transportAliases) ? device.transportAliases : [];
    return (
      record(device?.runtime)?.deviceId === deviceId ||
      record(device?.identity)?.stableId === deviceId ||
      aliases.includes(deviceId)
    );
  });
  return typeof match?.platform === "string" ? match.platform : undefined;
}

export function describeFailure(envelope: unknown): string {
  const state = envelopeState(envelope);
  const payload = state.payload;
  const candidates = [
    typeof payload?.error === "string" ? payload.error : record(payload?.error)?.message,
    payload?.message,
    record(envelope)?.isError ? state.texts.join("\n") : undefined,
  ];
  return (
    candidates
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim() ?? "failed with no error message"
  );
}
