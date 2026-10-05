import { errorMessage } from "../../utils/describeUnknownError";
import { ActionableError } from "../../models/ActionableError";
import { getAbortSignal, getRequestContext, runWithAbortSignal } from "../../utils/AbortContext";

/** Keep short iOS text requests at the existing transport timeout. */
export const DEFAULT_TEXT_REQUEST_TIMEOUT_MS = 5000;
export const MAX_TEXT_REQUEST_TIMEOUT_MS = 120_000;
const TEXT_REPLY_HEADROOM_MS = 2000;

// ios/control-proxy/Sources/CtrlProxyRewrite/GesturePerformer.swift:1347-1360
// calls XCUIApplication.typeText with no
// per-key cadence or overall typing budget. This conservative allowance needs
// one simulator measurement; it is not a measured XCUITest rate.
export const CONSERVATIVE_IOS_TEXT_PER_CODE_POINT_MS = 100;

/** Deadline clamping takes precedence over the compatibility floor. */
export function resolveTextCtrlProxyTimeoutMs(
  text: string,
  remainingRequestBudgetMs?: number,
): number {
  const timeoutMs = Math.min(
    MAX_TEXT_REQUEST_TIMEOUT_MS,
    Math.max(
      DEFAULT_TEXT_REQUEST_TIMEOUT_MS,
      Array.from(text).length * CONSERVATIVE_IOS_TEXT_PER_CODE_POINT_MS + TEXT_REPLY_HEADROOM_MS,
    ),
  );
  return remainingRequestBudgetMs === undefined
    ? timeoutMs
    : Math.max(0, Math.min(timeoutMs, remainingRequestBudgetMs));
}

/** Covers focus/clear and the final observation outside the text transport. */
export const TEXT_MCP_REQUEST_HEADROOM_MS = 20_000;
/** Return a terminal result before the enclosing request/safety-net timer fires. */
export const TEXT_REQUEST_RESPONSE_MARGIN_MS = 1000;

export class TextIndeterminateError extends ActionableError {
  readonly retryable = false;

  constructor(reason: string) {
    super(
      `Text outcome is indeterminate: the request was dispatched but no result was confirmed (${reason}). The text may have been entered or cleared. Do not retry automatically. Observe before retrying.`,
    );
  }
}

/** Request-local evidence; only iOS text transports mark dispatch here. */
export class TextRequestState {
  private pending = 0;
  private readonly unconfirmedErrors = new WeakSet<Error>();

  dispatched(): (confirmed: boolean, error?: unknown) => void {
    this.pending++;
    let completed = false;
    return (confirmed, error) => {
      if (completed) {
        return;
      }
      completed = true;
      this.pending--;
      // Completed results carry their own indeterminate marker. Only the same
      // thrown Error may relabel a failure after this command is no longer pending.
      if (!confirmed && error instanceof Error) {
        this.unconfirmedErrors.add(error);
      }
    };
  }

  timeoutError(error: unknown): TextIndeterminateError | undefined {
    return this.pending > 0 || (error instanceof Error && this.unconfirmedErrors.has(error))
      ? new TextIndeterminateError(errorMessage(error))
      : undefined;
  }
}

export function getTextRequestDeadlineMs(): number | undefined {
  const deadlineMs = getRequestContext()?.getDeadlineMs?.();
  return deadlineMs === undefined ? undefined : deadlineMs - TEXT_REQUEST_RESPONSE_MARGIN_MS;
}

export function runWithTextRequestContext<T>(
  context: { getDeadlineMs: () => number | undefined; textState?: TextRequestState },
  work: () => Promise<T>,
): Promise<T> {
  return runWithAbortSignal(getAbortSignal(), work, {
    ...context,
    textState: context.textState ?? getRequestContext()?.textState ?? new TextRequestState(),
  });
}
