import { ActionableError } from "../../../../models/ActionableError";

export class InvalidPrototypeIdError extends ActionableError {
  readonly code = "invalid_prototype_id";
  constructor(cause?: unknown) {
    super("Prototype id must contain non-whitespace characters", { cause });
  }
}
