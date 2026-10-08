import { promises as fsPromises } from "node:fs";
import path from "node:path";
import type { PlanExecutionResult } from "../models/Plan";
import type {
  ExecutePlanStepDebugInfo,
  PlanHealthSummary,
  PlanToolHealth,
} from "../models/ExecutePlanResult";
import { createTimestampedId, defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

/** Opt-in env var: a directory that receives one health-summary JSON file per plan run (#2306). */
export const PLAN_HEALTH_DIR_ENV = "AUTOMOBILE_PLAN_HEALTH_DIR";

export interface PlanHealthRunInfo {
  success: boolean;
  totalSteps: number;
  executedSteps: number;
  warningCount: number;
  durationMs: number;
}

/** Records step outcomes in memory and folds them into a {@link PlanHealthSummary}. */
export interface PlanHealthCollector {
  recordStep(step: ExecutePlanStepDebugInfo): void;
  summarize(run: PlanHealthRunInfo): PlanHealthSummary;
}

const STEP_TOOL_PATTERN = /:\s*(\S+)$/;

export class InMemoryPlanHealthCollector implements PlanHealthCollector {
  private readonly steps: { tool: string; status: string; durationMs: number }[] = [];

  recordStep(step: ExecutePlanStepDebugInfo): void {
    const tool = STEP_TOOL_PATTERN.exec(step.step)?.[1] ?? step.step;
    this.steps.push({ tool, status: step.status, durationMs: step.durationMs });
  }

  summarize(run: PlanHealthRunInfo): PlanHealthSummary {
    const byTool = new Map<string, PlanToolHealth>();
    let slowest: PlanHealthSummary["slowestStep"];
    this.steps.forEach((step, stepIndex) => {
      const entry = byTool.get(step.tool) ?? {
        tool: step.tool,
        count: 0,
        failed: 0,
        skipped: 0,
        totalMs: 0,
        maxMs: 0,
      };
      entry.count += 1;
      entry.failed += step.status === "failed" ? 1 : 0;
      entry.skipped += step.status === "skipped" ? 1 : 0;
      entry.totalMs += step.durationMs;
      entry.maxMs = Math.max(entry.maxMs, step.durationMs);
      byTool.set(step.tool, entry);
      if (!slowest || step.durationMs > slowest.durationMs) {
        slowest = { stepIndex, tool: step.tool, durationMs: step.durationMs };
      }
    });
    return {
      ...run,
      failedSteps: this.steps.filter((s) => s.status === "failed").length,
      skippedSteps: this.steps.filter((s) => s.status === "skipped").length,
      ...(slowest ? { slowestStep: slowest } : {}),
      tools: [...byTool.values()],
    };
  }
}

/** Builds the summary for a finished run from the step trace the executor always returns. */
export function buildPlanHealthSummary(
  steps: ExecutePlanStepDebugInfo[] | undefined,
  run: PlanHealthRunInfo,
  collector: PlanHealthCollector = new InMemoryPlanHealthCollector(),
): PlanHealthSummary {
  for (const step of steps ?? []) {
    collector.recordStep(step);
  }
  return collector.summarize(run);
}

/** Persists a summary; the production implementation writes JSON under a directory. */
export interface PlanHealthWriter {
  write(summary: PlanHealthSummary): Promise<void>;
}

export class FilePlanHealthWriter implements PlanHealthWriter {
  constructor(
    private readonly dir: string,
    private readonly timer: Pick<Timer, "now">,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
  ) {}

  async write(summary: PlanHealthSummary): Promise<void> {
    try {
      await fsPromises.mkdir(this.dir, { recursive: true });
      const name = `${createTimestampedId("plan-health", this.timer, this.idGenerator)}.json`;
      await fsPromises.writeFile(path.join(this.dir, name), JSON.stringify(summary, null, 2));
    } catch (error) {
      // Diagnostics must never fail the plan; leave a trace and carry on.
      logger.warn(`Failed to write plan health summary to ${this.dir}: ${errorMessage(error)}`);
    }
  }
}

/** The writer selected by {@link PLAN_HEALTH_DIR_ENV}, or undefined when it is unset. */
export function planHealthWriterFromEnv(
  timer: Pick<Timer, "now">,
  env: NodeJS.ProcessEnv = process.env,
): PlanHealthWriter | undefined {
  const dir = env[PLAN_HEALTH_DIR_ENV];
  return dir ? new FilePlanHealthWriter(dir, timer) : undefined;
}

/**
 * Opt-in: with no writer (env var unset) this does nothing and returns undefined. Otherwise summarizes a finished run (`undefined` when the plan never produced a result), hands the summary
 * to the optional writer, and returns it for the `executePlan` response.
 */
export async function reportPlanHealth(
  writer: PlanHealthWriter | undefined,
  result: HealthSourceResult | undefined,
  durationMs: number,
): Promise<PlanHealthSummary | undefined> {
  if (!writer) {
    return undefined;
  }
  const source = result ?? { success: false, totalSteps: 0, executedSteps: 0 };
  const summary = buildPlanHealthSummary(result ? healthStepsOf(result) : undefined, {
    success: source.success,
    totalSteps: source.totalSteps,
    executedSteps: source.executedSteps,
    warningCount: result?.warnings?.length ?? 0,
    durationMs,
  });
  await writer.write(summary);
  return summary;
}

type HealthSourceResult = Pick<
  PlanExecutionResult,
  | "success"
  | "totalSteps"
  | "executedSteps"
  | "warnings"
  | "debug"
  | "perDeviceResults"
  | "failedStep"
>;

/**
 * The step trace a summary is built from. A single-device run carries it in `debug.steps`; a
 * device-labelled run has no `debug`, so the tracks' traces are concatenated in label order.
 * A track that failed without recording the failing step (an unexpected error, or a failure
 * before any step ran) still counts as one failed step, so `failedSteps` never reads 0 for a
 * failed plan.
 */
function healthStepsOf(result: HealthSourceResult): ExecutePlanStepDebugInfo[] | undefined {
  if (result.debug) {
    return result.debug.steps;
  }
  if (!result.perDeviceResults) {
    return undefined;
  }
  return [...result.perDeviceResults.values()].flatMap((track) => {
    const steps = track.steps ?? [];
    const failed = track.failedStep;
    if (!failed || steps.some((step) => step.status === "failed")) {
      return steps;
    }
    return [
      ...steps,
      {
        step: `Execute step ${failed.stepIndex + 1}: ${failed.tool}`,
        status: "failed" as const,
        durationMs: 0,
      },
    ];
  });
}

/** The `healthSummary` response field, omitted entirely when health reporting is off. */
export function healthSummaryField(summary: PlanHealthSummary | undefined): {
  healthSummary?: PlanHealthSummary;
} {
  return summary ? { healthSummary: summary } : {};
}
