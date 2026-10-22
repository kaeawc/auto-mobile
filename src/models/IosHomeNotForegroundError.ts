import { ActionableError } from "./ActionableError";

/** Home press left another app in the foreground; carries which one so callers can recover. */
export class IosHomeNotForegroundError extends ActionableError {
  constructor(
    message: string,
    readonly foregroundApp: string,
  ) {
    super(message);
  }
}
