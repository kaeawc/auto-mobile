import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { IosCameraPosterDeviceConfig } from "./IosCameraPosterDeviceConfig";
import type { IosCameraPoster, IosCameraPosterRegistry } from "./IosCameraPosterRegistry";

/** Undoes a simulator's device-wide launchd environment; a no-op when it was never turned on. */
export type IosCameraPosterDeactivator = (udid: string) => Promise<void>;

/**
 * Keeps each simulator's config file in step with the registry, so every path that clears a
 * poster (setDeviceState clear, killDevice, session release or rebind) also turns off the
 * device-wide camera, and then restores the simulator's launchd environment. A failure is logged,
 * never thrown: the per-launch injection that `launchApp` applies does not depend on either.
 */
export class DeviceConfigMirroringIosCameraPosterRegistry implements IosCameraPosterRegistry {
  constructor(
    private readonly inner: IosCameraPosterRegistry,
    private readonly config: IosCameraPosterDeviceConfig,
    private readonly deactivate: IosCameraPosterDeactivator = async () => {},
  ) {}

  set(udid: string, poster: IosCameraPoster): void {
    this.inner.set(udid, poster);
    this.mirror(udid, "write", () => this.config.write(udid, poster));
  }

  get(udid: string): IosCameraPoster | undefined {
    return this.inner.get(udid);
  }

  clear(udid: string): void {
    this.inner.clear(udid);
    // Removing the file is synchronous, so no app launched after clear loads the poster even
    // before the launchd environment below is restored.
    this.mirror(udid, "remove", () => this.config.remove(udid));
    void this.deactivate(udid).catch((error: unknown) => {
      logger.warn(
        `Failed to restore the launchd environment after clearing the camera poster on ${udid}: ${errorMessage(error)}`,
        error,
      );
    });
  }

  private mirror(udid: string, action: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      logger.warn(
        `Failed to ${action} the device-wide camera poster config for ${udid}: ${errorMessage(error)}`,
        error,
      );
    }
  }
}
