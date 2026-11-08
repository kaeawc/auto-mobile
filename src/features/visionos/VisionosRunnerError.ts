import { ActionableError } from "../../models/ActionableError";
export class VisionosRunnerError extends ActionableError {
  constructor(
    message: string,
    readonly errorCode: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
