import { ActionableError } from "../../models/ActionableError";

/** Client-local transport failure: retrying could repeat an already executed tool. */
export class DaemonFrameTooLargeError extends ActionableError {
  constructor(readonly limitBytes: number) {
    super(`Daemon response frame exceeded ${limitBytes} bytes; the daemon connection was closed.`);
    this.name = "DaemonFrameTooLargeError";
  }
}
