import { ActionableError } from "../../models/ActionableError";

/**
 * Deepest chain of plans a plan may start through `executePlan` steps, counting the outermost
 * plan as level 1. A shared login flow called from a test plan is level 2; a plan that includes
 * itself would otherwise recurse until the stack or the request deadline gave out, so the chain
 * is bounded with a clear error instead (#10172). There was no earlier executePlan nesting limit
 * to reuse (the `criticalSection` depth in the daemon's budget walker bounds a different thing).
 */
export const MAX_PLAN_NESTING_DEPTH = 4;

/**
 * Nesting level of the plan that is about to start, given the level of the plan it runs inside
 * (`undefined` at the MCP boundary, where no plan is running). The level travels in the request's
 * async tool-selection context, so concurrent plans on different sessions never share a count.
 */
export function nextPlanNestingDepth(enclosingDepth: number | undefined): number {
  const depth = (enclosingDepth ?? 0) + 1;
  if (depth > MAX_PLAN_NESTING_DEPTH) {
    throw new ActionableError(
      `executePlan steps are nested more than ${MAX_PLAN_NESTING_DEPTH} plans deep ` +
        `(a plan that includes itself recurses forever). Flatten the plan or remove the cycle.`,
    );
  }
  return depth;
}
