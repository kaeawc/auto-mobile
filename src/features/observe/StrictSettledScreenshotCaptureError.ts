import { ActionableError, toActionableError } from "../../models/ActionableError";

export class StrictSettledScreenshotCaptureError extends ActionableError {
  constructor(error: unknown, deviceId: string) {
    super(toActionableError(error, `Failed to capture screenshot for device ${deviceId}`).message, {
      cause: error,
    });
  }
}
