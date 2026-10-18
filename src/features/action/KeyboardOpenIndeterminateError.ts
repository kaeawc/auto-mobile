import { ActionableError } from "../../models/ActionableError";

export function keyboardOpenIndeterminateMessage(dispatched: string, reason?: string): string {
  return `Keyboard open outcome is indeterminate: the ${dispatched} was dispatched but no result was confirmed (${reason ?? "request cancelled"}). The keyboard may have opened. Do not retry automatically; observe before retrying.`;
}

/** A cancelled open whose click/tap was already sent: the device may have applied it. */
export class KeyboardOpenIndeterminateError extends ActionableError {
  constructor(dispatched: string, reason?: string) {
    super(keyboardOpenIndeterminateMessage(dispatched, reason));
    this.name = "KeyboardOpenIndeterminateError";
  }
}
