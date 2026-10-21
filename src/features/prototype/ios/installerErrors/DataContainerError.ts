import { ActionableError } from "../../../../models/ActionableError";

export class DataContainerError extends ActionableError {
  readonly code = "prototype_data_container";
  constructor(cause?: unknown) {
    super("Could not access the prototype viewer data container", { cause });
  }
}
