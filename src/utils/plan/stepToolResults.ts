import type { PlanStepToolResult, PlanToolResultsTruncation } from "../../models/ExecutePlanResult";

/** Largest serialized result kept for one step before it is narrowed to its core fields. */
export const MAX_STEP_TOOL_RESULT_CHARS = 8 * 1024;

/**
 * Hard serialized budget for the whole `toolResults` array of one plan, across every device track
 * (entries count in full: `stepIndex`, `tool`, `device` and `result`). Once an entry does not fit,
 * it and every later one is left out and counted in `toolResultsTruncated.omittedSteps`.
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

/**
 * One `toolResults` budget shared by every device track's collector of a plan, so a multi-device
 * plan cannot return one budget per track. Sticky: after the first entry that does not fit, no
 * later entry is admitted, so the retained entries are a prefix of what completed.
 */
export class PlanToolResultsBudget {
  private spentChars = 0;
  private omitted = 0;
  private exhausted = false;

  constructor(private readonly maxChars: number = MAX_PLAN_TOOL_RESULTS_CHARS) {}

  /** Reserves room for one serialized entry (plus its array separator), or records it omitted. */
  admit(entry: PlanStepToolResult): boolean {
    const chars = serializedLength(entry) + 1;
    if (this.exhausted || this.spentChars + chars > this.maxChars) {
      this.exhausted = true;
      this.omitted++;
      return false;
    }
    this.spentChars += chars;
    return true;
  }

  /** The `toolResultsTruncated` response field, present only once an entry was omitted. */
  asField(): { toolResultsTruncated?: PlanToolResultsTruncation } {
    return this.omitted > 0 ? { toolResultsTruncated: { omittedSteps: this.omitted } } : {};
  }
}

/** Collects bounded per-step tool results for one device track (or a single-device plan). */
export class StepToolResultCollector {
  private readonly entries: PlanStepToolResult[] = [];

  constructor(private readonly budget: PlanToolResultsBudget = new PlanToolResultsBudget()) {}

  /**
   * Records a completed step's payload. Anything that is not a JSON object (an image-only
   * success, say) carries nothing to expose and is skipped. An entry the shared budget cannot
   * hold is not recorded; the budget counts it for `toolResultsTruncated`.
   */
  add(stepIndex: number, tool: string, payload: unknown, device?: string): void {
    if (!isPlainObject(payload)) {
      return;
    }
    const bounded = boundStepToolResult(payload);
    const entry: PlanStepToolResult = {
      stepIndex,
      tool,
      ...(device ? { device } : {}),
      result: bounded.result,
      ...(bounded.truncated ? { truncated: true } : {}),
    };
    if (this.budget.admit(entry)) {
      this.entries.push(entry);
    }
  }

  /** Entries in plan step order, or undefined when no step produced a result. */
  toArray(): PlanStepToolResult[] | undefined {
    return this.entries.length > 0
      ? [...this.entries].sort((a, b) => a.stepIndex - b.stepIndex)
      : undefined;
  }

  /** The `toolResults` (and, once the budget ran out, `toolResultsTruncated`) response fields. */
  asField(): {
    toolResults?: PlanStepToolResult[];
    toolResultsTruncated?: PlanToolResultsTruncation;
  } {
    const toolResults = this.toArray();
    return { ...(toolResults ? { toolResults } : {}), ...this.budget.asField() };
  }
}
