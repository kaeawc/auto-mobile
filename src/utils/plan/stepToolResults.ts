import type { PlanStepToolResult } from "../../models/ExecutePlanResult";

/** Largest serialized result kept for one step before it is narrowed to its core fields. */
export const MAX_STEP_TOOL_RESULT_CHARS = 8 * 1024;

/**
 * Serialized budget for all step results of one plan. Once spent, later steps still get an entry
 * (so `getToolResult(i)` can tell "ran" from "did not run") but only carry `success`.
 */
export const MAX_PLAN_TOOL_RESULTS_CHARS = 64 * 1024;

/**
 * Payload fields that are bulky and already have their own channel: the embedded observation and
 * view hierarchies (`captureObserveSteps` / `failedStep.failureObservation`), the tap diagnostics
 * (`debug.steps[n].details.tapDebug`) and the best-effort warnings (`warnings`).
 */
const DROPPED_FIELDS: ReadonlySet<string> = new Set([
  "observation",
  "viewHierarchy",
  "rawViewHierarchy",
  "elements",
  "tapDebug",
  "debug",
  "warnings",
]);

/** Fields kept when a step's result is still over the per-step cap after dropping the bulky ones. */
const CORE_FIELDS = [
  "success",
  "action",
  "message",
  "error",
  "selectedElement",
  "selectedElements",
] as const;

function isDroppedField(key: string): boolean {
  return DROPPED_FIELDS.has(key) || key.startsWith("screenshot");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

function withoutBulkyFields(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !isDroppedField(key)));
}

function coreFields(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    CORE_FIELDS.filter((key) => key in payload).map((k) => [k, payload[k]]),
  );
}

function successOnly(payload: Record<string, unknown>): Record<string, unknown> {
  return typeof payload.success === "boolean" ? { success: payload.success } : {};
}

/**
 * Bounds one completed step's tool payload for the `executePlan` response. Returns the payload
 * with bulky fields dropped, narrowed to its core fields (and flagged `truncated`) when it is
 * still larger than `maxChars`.
 */
export function boundStepToolResult(
  payload: Record<string, unknown>,
  maxChars: number = MAX_STEP_TOOL_RESULT_CHARS,
): { result: Record<string, unknown>; truncated: boolean } {
  const trimmed = withoutBulkyFields(payload);
  if (serializedLength(trimmed) <= maxChars) {
    return { result: trimmed, truncated: false };
  }
  const core = coreFields(trimmed);
  return {
    result: serializedLength(core) <= maxChars ? core : successOnly(trimmed),
    truncated: true,
  };
}

/** Collects bounded per-step tool results for one `executePlan` run. */
export class StepToolResultCollector {
  private readonly entries: PlanStepToolResult[] = [];
  private spentChars = 0;

  /**
   * Records a completed step's payload. Anything that is not a JSON object (an image-only
   * success, say) carries nothing to expose and is skipped.
   */
  add(stepIndex: number, tool: string, payload: unknown, device?: string): void {
    if (!isPlainObject(payload)) {
      return;
    }
    const bounded = boundStepToolResult(payload);
    const overBudget =
      this.spentChars + serializedLength(bounded.result) > MAX_PLAN_TOOL_RESULTS_CHARS;
    const result = overBudget ? successOnly(payload) : bounded.result;
    this.spentChars += serializedLength(result);
    this.entries.push({
      stepIndex,
      tool,
      ...(device ? { device } : {}),
      result,
      ...(bounded.truncated || overBudget ? { truncated: true } : {}),
    });
  }

  /** Entries in plan step order, or undefined when no step produced a result. */
  toArray(): PlanStepToolResult[] | undefined {
    return this.entries.length > 0
      ? [...this.entries].sort((a, b) => a.stepIndex - b.stepIndex)
      : undefined;
  }

  /** The `toolResults` field of a plan result, omitted when no step produced one. */
  asField(): { toolResults?: PlanStepToolResult[] } {
    const toolResults = this.toArray();
    return toolResults ? { toolResults } : {};
  }
}
