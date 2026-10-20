import { errorMessage } from "../../utils/describeUnknownError";
import { CtrlProxyForwardingLeaseConflictError } from "./shared/CtrlProxyForwardingLeaseConflictError";

/** Retains the last dial failure for readiness diagnostics until the budget is reset. */
export class ConnectionFailureRecord {
  message: string | undefined;
  isForwardingLeaseConflict = false;
  isTransientLeaseConflict = false;

  clear(): void {
    this.message = undefined;
    this.isForwardingLeaseConflict = false;
    this.isTransientLeaseConflict = false;
  }

  record(error: unknown): void {
    this.message = errorMessage(error);
    this.isForwardingLeaseConflict = error instanceof CtrlProxyForwardingLeaseConflictError;
    this.isTransientLeaseConflict =
      error instanceof CtrlProxyForwardingLeaseConflictError && error.transient;
  }
}
