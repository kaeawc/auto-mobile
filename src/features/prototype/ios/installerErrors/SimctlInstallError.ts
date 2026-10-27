import { ActionableError } from "../../../../models/ActionableError";

export class SimctlInstallError extends ActionableError {
  readonly code = "prototype_simctl_install";
  constructor(cause?: unknown) {
    super("Could not install the prototype viewer", { cause });
  }
}
