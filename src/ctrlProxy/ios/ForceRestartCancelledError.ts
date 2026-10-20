import { errorMessage } from "../../utils/describeUnknownError";

export class ForceRestartCancelledError extends Error {
  constructor(reason: unknown) {
    super(errorMessage(reason), { cause: reason });
    this.name = "ForceRestartCancelledError";
  }
}
