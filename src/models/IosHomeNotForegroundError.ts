import { ActionableError } from "./ActionableError";

/** SpringBoard did not come to the foreground; names the app that stayed there when known. */
export class IosHomeNotForegroundError extends ActionableError {
  constructor(
    message: string,
    readonly foregroundApp?: string,
  ) {
    super(message);
  }
}
