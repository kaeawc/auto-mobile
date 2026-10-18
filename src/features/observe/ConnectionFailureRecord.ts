/**
 * ConnectionFailureRecord - the most recent connect-attempt failure of a device
 * service client (issue #6260).
 *
 * `waitForConnection` only reports a boolean, so a caller that needs the actual
 * cause of a connect failure (RunnerReadinessService, to surface it instead of a
 * generic "runner did not become responsive") reads this instead of re-deriving
 * it. Cleared on a successful connect.
 */

import { errorMessage } from "../../utils/describeUnknownError";
import { CtrlProxyForwardingLeaseConflictError } from "./shared/CtrlProxyForwardingLeaseConflictError";

export class ConnectionFailureRecord {
  private message: string | undefined;
  // Detected via `instanceof` on the caught error so RunnerReadinessService can
  // scope its orphan-naming diagnostic to this exact condition instead of any
  // stored error.
  private forwardingLeaseConflict = false;
  private transientLeaseConflict = false;

  record(error: unknown): void {
    this.message = errorMessage(error);
    this.forwardingLeaseConflict = error instanceof CtrlProxyForwardingLeaseConflictError;
    this.transientLeaseConflict =
      error instanceof CtrlProxyForwardingLeaseConflictError && error.transient;
  }

  clear(): void {
    this.message = undefined;
    this.forwardingLeaseConflict = false;
    this.transientLeaseConflict = false;
  }

  getMessage(): string | undefined {
    return this.message;
  }

  /** Whether the stored failure is the CtrlProxy forwarding-lease conflict specifically. */
  isForwardingLeaseConflict(): boolean {
    return this.forwardingLeaseConflict;
  }

  /** Whether that lease conflict is a time-based refusal a readiness wait should retry (#10485). */
  isTransientLeaseConflict(): boolean {
    return this.transientLeaseConflict;
  }
}
