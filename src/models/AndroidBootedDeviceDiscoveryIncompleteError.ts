import { BootedDeviceDiscoveryIncompleteError } from "./BootedDeviceDiscoveryIncompleteError.base";

/** Android flavour of {@link BootedDeviceDiscoveryIncompleteError}. */
export class AndroidBootedDeviceDiscoveryIncompleteError extends BootedDeviceDiscoveryIncompleteError {
  constructor(
    discoveryError: ConstructorParameters<typeof BootedDeviceDiscoveryIncompleteError>[1],
    message?: string,
  ) {
    super("android", discoveryError, message);
  }
}
