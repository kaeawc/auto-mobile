import { ActionableError } from "../../models/ActionableError";

const TEXT_INDETERMINATE_PREFIX = "Text outcome is indeterminate:";

/** True for the message a dispatched-but-unconfirmed text command carries. */
export function isTextIndeterminateMessage(message: string | undefined): boolean {
  return message?.startsWith(TEXT_INDETERMINATE_PREFIX) === true;
}

export class TextIndeterminateError extends ActionableError {
  readonly retryable = false;

  constructor(reason: string) {
    super(
      `${TEXT_INDETERMINATE_PREFIX} the request was dispatched but no result was confirmed (${reason}). The text may have been entered or cleared. Do not retry automatically. Observe before retrying.`,
    );
  }
}
