import { ActionableError } from "../../../../models/ActionableError";

export class TemplateCopyError extends ActionableError {
  readonly code = "prototype_template_copy";
  constructor(cause?: unknown) {
    super("Could not copy the prototype viewer template", { cause });
  }
}
