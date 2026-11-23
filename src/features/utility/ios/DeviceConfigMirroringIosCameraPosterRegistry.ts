import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { IosCameraPosterDeviceConfig } from "./IosCameraPosterDeviceConfig";
import type { IosCameraPoster, IosCameraPosterRegistry } from "./IosCameraPosterRegistry";

/**
 * Keeps each simulator's config file in step with the registry, so every path that clears a
 * poster (setDeviceState clear, killDevice, session release or rebind) also turns off the
 * device-wide camera. A file failure is logged, never thrown: the per-launch injection that
 * `launchApp` applies does not depend on the file.
 */
export class DeviceConfigMirroringIosCameraPosterRegistry implements IosCameraPosterRegistry {
  constructor(
    private readonly inner: IosCameraPosterRegistry,
    private readonly config: IosCameraPosterDeviceConfig,
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
    this.mirror(udid, "remove", () => this.config.remove(udid));
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
