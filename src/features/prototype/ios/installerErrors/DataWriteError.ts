import { ActionableError } from "../../../../models/ActionableError";

export class DataWriteError extends ActionableError {
  readonly code = "prototype_data_write";
  constructor(cause?: unknown) {
    super("Could not write the prototype viewer spec", { cause });
  }
}
