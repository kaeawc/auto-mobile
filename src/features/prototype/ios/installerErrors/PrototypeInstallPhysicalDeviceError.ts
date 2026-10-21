import { ActionableError } from "../../../../models/ActionableError";

export class PrototypeInstallPhysicalDeviceError extends ActionableError {
  readonly code = "prototype_install_physical_device";
  constructor(cause?: unknown) {
    super("Prototype viewer installation is simulator only", { cause });
  }
}
