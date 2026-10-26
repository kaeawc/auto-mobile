/**
 * A bounded `simctl` command exceeded its own deadline and its child was killed. Typed so a
 * caller that must treat "dispatched, never acknowledged" differently from a plain non-zero exit
 * (an uninstall) does not have to match on the message text.
 */
export class SimctlCommandTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SimctlCommandTimeoutError";
  }
}

// Bound traversal even for cyclic/foreign Error.cause graphs.
const MAX_CAUSE_DEPTH = 8;

/** Whether `error`, or a wrapped cause, is a {@link SimctlCommandTimeoutError}. */
export function hasSimctlTimeoutCause(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof SimctlCommandTimeoutError) {
      return true;
    }
    if (!(current instanceof Error) || current.cause === undefined) {
      return false;
    }
    current = current.cause;
  }
  return false;
}
