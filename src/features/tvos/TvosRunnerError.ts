import { ActionableError } from "../../models/ActionableError";
export class TvosRunnerError extends ActionableError {
  constructor(
    message: string,
    readonly errorCode: string,
  ) {
    super(message);
  }
}
