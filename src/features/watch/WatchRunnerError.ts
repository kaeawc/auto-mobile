import { ActionableError } from "../../models/ActionableError";
export class WatchRunnerError extends ActionableError {
  constructor(
    message: string,
    readonly errorCode: string,
  ) {
    super(message);
  }
}
