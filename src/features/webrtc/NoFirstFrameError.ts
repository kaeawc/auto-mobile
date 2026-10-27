import { ActionableError } from "../../models";

export class NoFirstFrameError extends ActionableError {
  finalStartupError(_approvalTarget: string | null): Error {
    return this;
  }
}
