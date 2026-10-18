import { ActionableError } from "../../models/ActionableError";

export class TextIndeterminateError extends ActionableError {
  readonly retryable = false;

  constructor(reason: string) {
    super(
      `Text outcome is indeterminate: the request was dispatched but no result was confirmed (${reason}). The text may have been entered or cleared. Do not retry automatically. Observe before retrying.`,
    );
  }
}
