import { ActionableError } from "../../../../models/ActionableError";

export class PrototypeListError extends ActionableError {
  readonly code = "prototype_list";
  constructor(cause?: unknown) {
    super("Could not list installed prototype viewers", { cause });
  }
}
