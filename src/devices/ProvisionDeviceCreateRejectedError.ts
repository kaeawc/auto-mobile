import { ProvisionDeviceError } from "./ProvisionDeviceError";

/**
 * The platform tool reported that it did not create the device (e.g. avdmanager
 * exited non-zero because the name already exists). Nothing this request owns
 * exists, so rollback must not target the requested name: it may belong to a
 * racing external create or a device a stale listing missed (#11100).
 */
export class ProvisionDeviceCreateRejectedError extends ProvisionDeviceError {
  constructor(message: string) {
    super("platform_command_failed", message);
    this.name = "ProvisionDeviceCreateRejectedError";
  }
}
