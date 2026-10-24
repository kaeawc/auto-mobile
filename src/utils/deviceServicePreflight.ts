import type { BootedDevice } from "../models";
import { DeviceServiceDisabledError } from "../models/DeviceServiceDisabledError";
import { errorMessage } from "./describeUnknownError";
import { getDeviceServiceDependencies } from "./deviceServiceDependencies";
import { iosDeviceResourceCatalog } from "./iosDeviceResourceCatalog";
import { resolveIosDeviceKind } from "./ios-cmdline-tools/IosDeviceKind";
import { PlistClient, type PlistReader } from "./ios-cmdline-tools/PlistClient";
import { logger } from "./logger";

export interface DeviceServicePreflight {
  assertEnabled(device: BootedDevice, tool: string, signal?: AbortSignal): Promise<void>;
}

/** Reads current host launchd overrides; no device transport or application-state DB. */
export class DefaultDeviceServicePreflight implements DeviceServicePreflight {
  private readonly plist: Pick<PlistReader, "readJsonFile">;
  constructor(options: { plist?: Pick<PlistReader, "readJsonFile"> } = {}) {
    this.plist = options.plist ?? new PlistClient();
  }

  async readDisabledLabels(deviceId: string, signal?: AbortSignal): Promise<ReadonlySet<string>> {
    signal?.throwIfAborted();
    try {
      const value = await this.plist.readJsonFile(
        `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${deviceId}/disabled.plist`,
        { signal },
      );
      signal?.throwIfAborted();
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Disabled-service plist is not a dictionary");
      }
      return new Set(
        Object.entries(value)
          .filter(([, disabled]) => disabled === true)
          .map(([label]) => label),
      );
    } catch (error) {
      signal?.throwIfAborted();
      const message = errorMessage(error);
      if (isMissingDisabledPlist(error, message)) {
        // No overrides exist yet; the simulator has no known disabled labels.
        logger.debug(`No simulator disabled-service plist for ${deviceId}`);
      } else {
        logger.warn(`Cannot read simulator disabled services for ${deviceId}: ${message}`, error);
      }
      return new Set();
    }
  }

  async assertEnabled(device: BootedDevice, tool: string, signal?: AbortSignal): Promise<void> {
    if (device.platform !== "ios" || resolveIosDeviceKind(device) !== "simulator") {
      return;
    }
    const dependencies = getDeviceServiceDependencies(tool);
    if (dependencies.length === 0) {
      return;
    }
    const disabled = await this.readDisabledLabels(device.deviceId, signal);
    for (const resource of Object.keys(
      iosDeviceResourceCatalog,
    ) as (keyof typeof iosDeviceResourceCatalog)[]) {
      const dependency = dependencies.find((entry) => entry.resources.includes(resource));
      if (!dependency) {
        continue;
      }
      const labels = iosDeviceResourceCatalog[resource];
      const disabledLabels = labels.filter((label) => disabled.has(label));
      if (disabledLabels.length > 0) {
        throw new DeviceServiceDisabledError({
          tool,
          resource,
          labels,
          disabledLabels,
          unavailable: dependency.unavailable,
          deviceId: device.deviceId,
        });
      }
    }
  }
}

function isMissingDisabledPlist(error: unknown, message: string): boolean {
  return (
    (error instanceof Error && "code" in error && error.code === "ENOENT") ||
    message.includes("ENOENT") ||
    /no such file/i.test(message)
  );
}
