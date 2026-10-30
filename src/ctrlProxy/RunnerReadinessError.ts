import type { RunnerReadinessPhase } from "./RunnerReadinessAttemptContext";
import { ActionableError } from "../models";

/** Trailing readiness detail: attempt count and the underlying diagnostic. */
export interface RunnerReadinessErrorDetails {
  attempts?: number;
  diagnosticCause?: unknown;
  failureKind?: "ctrlproxy_forward_unavailable";
}

export class RunnerReadinessError extends ActionableError {
  get code(): "timeout" | undefined {
    return this.deadlineExhausted ? "timeout" : undefined;
  }

  get retryable(): true | undefined {
    return this.deadlineExhausted ? true : undefined;
  }

  readonly attempts?: number;
  readonly diagnosticCause?: unknown;
  readonly failureKind?: "ctrlproxy_forward_unavailable";

  constructor(
    message: string,
    readonly retryableAndroidFrameworkFailure = false,
    /**
     * The phase ran out of budget rather than hitting a platform fault, so the
     * failure is purely time-based and callers may report it as a timeout and
     * retry it (`provisionDevice` maps this to error code `"timeout"`).
     */
    readonly deadlineExhausted = false,
    readonly phase?: RunnerReadinessPhase,
    details: RunnerReadinessErrorDetails = {},
  ) {
    super(message);
    this.attempts = details.attempts;
    this.diagnosticCause = details.diagnosticCause;
    this.failureKind = details.failureKind;
  }
}
