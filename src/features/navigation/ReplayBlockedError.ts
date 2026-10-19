import { ActionableError } from "../../models";
import type { RetryBlocker } from "./NavigateTo";

/**
 * A replay failure that was observed with a blocker already found (the pre-search
 * check), so the step outcome reuses it instead of observing the device a second time.
 */
export class ReplayBlockedError extends ActionableError {
  constructor(
    message: string,
    readonly blocker: RetryBlocker,
  ) {
    super(message);
  }
}
