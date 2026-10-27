import { ActionableError } from "../../../../models/ActionableError";

export class PrototypeUninstallError extends ActionableError {
  readonly code = "prototype_uninstall";
  constructor(cause?: unknown) {
    super("Could not uninstall the prototype viewer", { cause });
  }
}
