import { ActionableError } from "../../models/ActionableError";
/** A partial clone must be removed before retrying creation with the same name. */
export class TemplateCloneCleanupError extends ActionableError {
  constructor(error: unknown) {
    super(
      "Could not remove a partial simulator clone. Retry simulator cleanup before creating again.",
      { cause: error },
    );
  }
}
