import type { PlanStep } from "../../models/Plan";

/**
 * A step reaching validation before PlanNormalizer runs may carry coordination
 * fields (`lock`, `device`, `deviceCount`, ...) as plain siblings of
 * `tool`/`params` -- outside PlanStep's declared shape. The runtime check makes
 * the keyed read type-safe without a cast.
 */
type StepWithInlineFields = PlanStep & Record<string, unknown>;

function isStepWithInlineFields(step: PlanStep): step is StepWithInlineFields {
  return typeof step === "object" && step !== null;
}

/**
 * Resolve a coordination field honoring PlanNormalizer's params-wins
 * precedence, falling back to the inline sibling field.
 */
export function effectiveStepField(step: PlanStep, field: string): unknown {
  const params: Record<string, unknown> | undefined = step.params;
  if (params && typeof params === "object" && Object.hasOwn(params, field)) {
    return params[field];
  }
  return isStepWithInlineFields(step) ? step[field] : undefined;
}
