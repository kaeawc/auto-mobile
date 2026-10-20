import type { AndroidTransportRouting } from "../androidSerial";
import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { AdbClient } from "./AdbClient";
import type { RetryExecutor } from "../retry/RetryExecutor";
import { daemonDeviceAdmissionGate } from "../deviceAdmissionGate";
import { defaultEmulatorConsoleBusyRegistry } from "./EmulatorConsoleBusyRegistry";
import type { AdbClientFactory } from "./AdbClientFactory";

/**
 * Default factory that creates real AdbClient instances.
 */
export class DefaultAdbClientFactory implements AdbClientFactory {
  constructor(private readonly transportRouting?: AndroidTransportRouting) {}

  create(device?: BootedDevice | null, retryExecutor?: RetryExecutor): AdbExecutor {
    return new AdbClient(device ?? null, null, {
      retryExecutor,
      consoleBusyRegistry: defaultEmulatorConsoleBusyRegistry,
      transportRouting:
        this.transportRouting ?? daemonDeviceAdmissionGate.getAndroidTransportRouting?.(),
    });
  }
}
