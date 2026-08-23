import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "./workingDirectory";
import { logger, resolveAutomobileLogFormat } from "./logger";

const STARTUP_BENCHMARK_PREFIX = "STARTUP_BENCHMARK";

interface StartupBenchmarkReport {
  type: string;
  state: "in_progress" | "ready";
  timestamp: string;
  pid: number;
  label?: string;
  marks: Record<string, number>;
  phases: Record<string, number>;
  activePhases: string[];
  memoryUsage: NodeJS.MemoryUsage;
  meta: Record<string, unknown>;
}

export function isStartupBenchmarkEnabled(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (args.includes("--startup-benchmark")) {
    return true;
  }

  const envEnabled = (
    environment.AUTOMOBILE_STARTUP_BENCHMARK ??
    environment.AUTO_MOBILE_STARTUP_BENCHMARK ??
    ""
  ).toLowerCase();
  return (
    args.includes("--daemon-mode") &&
    (envEnabled === "1" || envEnabled === "true" || envEnabled === "yes")
  );
}

const enabled = isStartupBenchmarkEnabled(process.argv, process.env);

const outputPath =
  process.env.AUTOMOBILE_STARTUP_BENCHMARK_OUTPUT ??
  process.env.AUTO_MOBILE_STARTUP_BENCHMARK_OUTPUT;

const label =
  process.env.AUTOMOBILE_STARTUP_BENCHMARK_LABEL ?? process.env.AUTO_MOBILE_STARTUP_BENCHMARK_LABEL;

export interface StartupBenchmarkOptions {
  outputPath?: string;
  label?: string;
  now?: () => number;
  fileSystem?: StartupBenchmarkFileSystem;
}

export type StartupBenchmarkFileSystem = Pick<
  typeof fs,
  "existsSync" | "mkdirSync" | "renameSync" | "writeFileSync"
>;

export class StartupBenchmark {
  private marks = new Map<string, number>();
  private phaseStarts = new Map<string, number>();
  private phases = new Map<string, number>();
  private emitted = false;
  private emittedReport: { type: string; meta: Record<string, unknown> } | undefined;
  private readonly enabled: boolean;
  private readonly outputPath: string | undefined;
  private readonly label: string | undefined;
  private readonly now: () => number;
  private readonly fileSystem: StartupBenchmarkFileSystem;

  constructor(isEnabled: boolean, options: StartupBenchmarkOptions = {}) {
    this.enabled = isEnabled;
    const rawOutputPath = options.outputPath ?? outputPath;
    this.outputPath = rawOutputPath
      ? resolvePathFromDaemonLaunchWorkingDirectory(rawOutputPath)
      : undefined;
    this.label = options.label ?? label;
    this.now = options.now ?? performance.now;
    this.fileSystem = options.fileSystem ?? fs;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  mark(name: string): void {
    if (!this.enabled || this.marks.has(name)) {
      return;
    }
    this.marks.set(name, this.now());
    this.persistCheckpoint();
  }

  startPhase(name: string): void {
    if (!this.enabled || this.phases.has(name) || this.phaseStarts.has(name)) {
      return;
    }
    this.phaseStarts.set(name, this.now());
    this.persistCheckpoint();
  }

  async runPhase<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.startPhase(name);
    const result = await work();
    this.endPhase(name);
    return result;
  }

  endPhase(name: string): void {
    if (!this.enabled || this.phases.has(name)) {
      return;
    }
    const start = this.phaseStarts.get(name);
    if (start === undefined) {
      return;
    }
    this.phases.set(name, this.now() - start);
    this.phaseStarts.delete(name);
    this.persistCheckpoint();
  }

  recordPhase(name: string, durationMs: number): void {
    if (!this.enabled || this.phases.has(name)) {
      return;
    }
    this.phases.set(name, durationMs);
    this.persistCheckpoint();
  }

  emit(type: string, meta: Record<string, unknown> = {}): void {
    if (!this.enabled || this.emitted) {
      return;
    }
    this.emitted = true;
    this.emittedReport = { type, meta };

    const report = this.createReport(type, "ready", meta);
    const payload = JSON.stringify(report);

    this.writeReport(payload);
    if (resolveAutomobileLogFormat() === "json") {
      logger.info(payload);
      return;
    }
    process.stderr.write(`${STARTUP_BENCHMARK_PREFIX} ${payload}\n`);
  }

  private persistCheckpoint(): void {
    if (!this.enabled) {
      return;
    }
    const report = this.emittedReport
      ? this.createReport(this.emittedReport.type, "ready", this.emittedReport.meta)
      : this.createReport("startup-checkpoint", "in_progress");
    this.writeReport(JSON.stringify(report));
  }

  private createReport(
    type: string,
    state: StartupBenchmarkReport["state"],
    meta: Record<string, unknown> = {},
  ): StartupBenchmarkReport {
    const marks = Object.fromEntries(this.marks.entries());
    const phases = Object.fromEntries(this.phases.entries());

    return {
      type,
      state,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      label: this.label,
      marks,
      phases,
      activePhases: [...this.phaseStarts.keys()],
      memoryUsage: process.memoryUsage(),
      meta,
    };
  }

  private writeReport(payload: string): void {
    if (!this.outputPath) {
      return;
    }
    const dir = path.dirname(this.outputPath);
    if (!this.fileSystem.existsSync(dir)) {
      this.fileSystem.mkdirSync(dir, { recursive: true });
    }
    const temporaryPath = `${this.outputPath}.${process.pid}.tmp`;
    this.fileSystem.writeFileSync(temporaryPath, payload, "utf-8");
    this.fileSystem.renameSync(temporaryPath, this.outputPath);
  }
}

export const startupBenchmark = new StartupBenchmark(enabled);
