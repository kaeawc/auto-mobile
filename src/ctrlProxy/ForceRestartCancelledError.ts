import { errorMessage } from "../utils/describeUnknownError";

/** Marks a forced-restart failure caused by its initiating caller cancelling. */
export class ForceRestartCancelledError extends Error {
  constructor(reason: unknown) {
    super(errorMessage(reason), { cause: reason });
    this.name = "ForceRestartCancelledError";
  }
}
