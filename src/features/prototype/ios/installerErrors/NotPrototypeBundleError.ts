import { ActionableError } from "../../../../models/ActionableError";

export class NotPrototypeBundleError extends ActionableError {
  readonly code = "not_prototype_bundle";
  constructor(cause?: unknown) {
    super("Refusing to uninstall a bundle outside the prototype prefix", { cause });
  }
}
