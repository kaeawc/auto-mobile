import { ActionableError } from "../../models";

/**
 * A replay step that failed because the screen is not positioned the way the edge
 * needs, not because the edge is broken. navigateTo ranks the edge last for the rest of
 * the call so a fallback runs first, and settles it when the call ends
 * (`settleTransientEdgeFailure`) instead of demoting it outright. `searched` is whether
 * a scroll search ran and came up empty: only those misses count towards a lasting
 * demotion, because a refused replay says nothing about whether the target exists.
 */
export class ReplayTransientError extends ActionableError {
  constructor(
    message: string,
    readonly searched: boolean,
  ) {
    super(message);
  }
}
