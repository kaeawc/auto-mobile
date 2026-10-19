import type { PlanStepToolResult, PlanToolResultsTruncation } from "../../models/ExecutePlanResult";

/**
 * Hard serialized budget for the whole `toolResults` array of one plan, across every device track
 * (entries count in full: `stepIndex`, `tool`, `device` and `result`). Once an entry does not fit,
 * it and every later one is left out and counted in `toolResultsTruncated.omittedSteps`.
 */
export const MAX_PLAN_TOOL_RESULTS_CHARS = 64 * 1024;

export function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
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
