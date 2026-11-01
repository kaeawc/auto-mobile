import type { RunnerReadinessPhase } from "./RunnerReadinessAttemptContext";
import { ActionableError } from "../models";

/** Trailing readiness detail: attempt count and the underlying diagnostic. */
export interface RunnerReadinessErrorDetails {
  attempts?: number;
  diagnosticCause?: unknown;
  failureKind?: "ctrlproxy_forward_unavailable";
}

/** Optional RunnerReadinessError classification plus its trailing readiness detail. */
export interface RunnerReadinessErrorOptions extends RunnerReadinessErrorDetails {
  retryableAndroidFrameworkFailure?: boolean;
  deadlineExhausted?: boolean;
  phase?: RunnerReadinessPhase;
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
  readonly retryableAndroidFrameworkFailure: boolean;
  /**
   * The phase ran out of budget rather than hitting a platform fault, so the
   * failure is purely time-based and callers may report it as a timeout and
   * retry it (`provisionDevice` maps this to error code `"timeout"`).
   */
  readonly deadlineExhausted: boolean;
  readonly phase?: RunnerReadinessPhase;

  constructor(
    message: string,
    {
      retryableAndroidFrameworkFailure = false,
      deadlineExhausted = false,
      phase,
      ...details
    }: RunnerReadinessErrorOptions = {},
  ) {
    super(message);
    this.retryableAndroidFrameworkFailure = retryableAndroidFrameworkFailure;
    this.deadlineExhausted = deadlineExhausted;
    this.phase = phase;
    this.attempts = details.attempts;
    this.diagnosticCause = details.diagnosticCause;
    this.failureKind = details.failureKind;
  }
}
