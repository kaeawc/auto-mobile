import { ActionableError } from "../../../../models/ActionableError";

export class IconRenderError extends ActionableError {
  readonly code = "prototype_icon_render";
  constructor(cause?: unknown) {
    super("Could not render or write the prototype viewer icons", { cause });
  }
}
