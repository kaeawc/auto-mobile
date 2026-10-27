import { ActionableError } from "../../../../models/ActionableError";

export class TemplateResolveError extends ActionableError {
  readonly code = "prototype_template_resolve";
  constructor(cause?: unknown) {
    super(
      `Could not resolve the prototype viewer template${cause instanceof ActionableError ? `: ${cause.message}` : ""}`,
      { cause },
    );
  }
}
