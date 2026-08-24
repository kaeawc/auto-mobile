import { BootedDevice, DeviceInfo, Platform } from "../models";
import type { PooledDevice } from "./devicePool";

export interface DeviceAllocationCriteria {
  platform?: Platform;
  simulatorType?: string;
  iosVersion?: string;
}

export interface DeviceAllocationRequest {
  sessionId: string;
  criteria?: DeviceAllocationCriteria;
}

export type DevicePoolBootedDevice = BootedDevice & {
  simulatorType?: string;
  deviceType?: string;
};

/**
 * Stateless matcher for device allocation criteria.
 *
 * Owns the pure decision logic the device pool relies on: which pooled devices
 * or startable images satisfy a request's platform/type/version criteria, how
 * to rank requests by specificity, and how to derive simulator metadata. Holds
 * no pool state so it can be exercised in isolation with plain fixtures.
 */
export class DeviceCriteriaMatcher {
  /**
   * Sort requests so the most specific criteria are satisfied first.
   *
   * More constrained requests (platform + type + version) are harder to match,
   * so allocating them ahead of looser requests avoids handing their only
   * candidate to a request that would have accepted anything.
   */
  sortBySpecificity(requests: DeviceAllocationRequest[]): DeviceAllocationRequest[] {
    const score = (criteria?: DeviceAllocationCriteria): number => {
      if (!criteria) {
        return 0;
      }
      let result = 0;
      if (criteria.platform) {
        result += 1;
      }
      if (criteria.simulatorType) {
        result += 1;
      }
      if (criteria.iosVersion) {
        result += 1;
      }
      return result;
    };

    return [...requests].sort((a, b) => score(b.criteria) - score(a.criteria));
  }

  /**
   * Filter pooled devices down to those matching the criteria.
   *
   * Applies platform, simulator type, and iOS version constraints. An undefined
   * criteria field matches any value.
   */
  filterDevices(devices: PooledDevice[], criteria?: DeviceAllocationCriteria): PooledDevice[] {
    const normalizedType = this.normalizeValue(criteria?.simulatorType);
    const normalizedVersion = this.normalizeValue(criteria?.iosVersion);

    return devices.filter((device) => {
      if (criteria?.platform && device.platform !== criteria.platform) {
        return false;
      }

      if (normalizedType) {
        const deviceTypes = [device.name, device.simulatorType]
          .map((value) => this.normalizeValue(value))
          .filter((value): value is string => value !== undefined);
        if (!deviceTypes.includes(normalizedType)) {
          return false;
        }
      }

      if (normalizedVersion) {
        const deviceVersion = this.normalizeValue(device.iosVersion);
        if (deviceVersion !== normalizedVersion) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Whether a startable device image satisfies the criteria.
   */
  deviceImageMatchesCriteria(image: DeviceInfo, criteria?: DeviceAllocationCriteria): boolean {
    if (criteria?.platform && image.platform !== criteria.platform) {
      return false;
    }

    const normalizedType = this.normalizeValue(criteria?.simulatorType);
    if (normalizedType) {
      const imageTypes = [
        image.name,
        image.deviceType,
        this.displayNameFromIosDeviceType(image.deviceType),
      ]
        .map((value) => this.normalizeValue(value))
        .filter((value): value is string => value !== undefined);
      if (!imageTypes.includes(normalizedType)) {
        return false;
      }
    }

    const normalizedVersion = this.normalizeValue(criteria?.iosVersion);
    if (normalizedVersion) {
      const imageVersions = [
        image.iosVersion,
        image.osVersion,
        this.iosVersionFromRuntime(image.runtime),
      ]
        .map((value) => this.normalizeValue(value))
        .filter((value): value is string => value !== undefined);
      if (!imageVersions.includes(normalizedVersion)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Whether any image in a collection satisfies the allocation criteria.
   */
  someDeviceImageMatchesCriteria(
    images: Iterable<DeviceInfo>,
    criteria?: DeviceAllocationCriteria,
  ): boolean {
    for (const image of images) {
      if (this.deviceImageMatchesCriteria(image, criteria)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether Android rediscovery found the same AVD, or could not resolve its
   * name, on the same transport.
   */
  androidRediscoveryMatches(
    candidate: BootedDevice,
    expectedDeviceId: string,
    expectedAvdName: string,
  ): boolean {
    return (
      candidate.deviceId === expectedDeviceId &&
      (candidate.name === expectedAvdName || candidate.name === `Unknown (${expectedDeviceId})`)
    );
  }

  /**
   * Whether pooled devices plus eligible Android recoveries can satisfy a request.
   */
  hasSufficientCapacityIncludingAndroidRecovery(
    pooledDeviceCount: number,
    requiredCount: number,
    pendingAndroidRecoveryCount: number,
    platform?: Platform,
  ): boolean {
    const eligibleRecoveryCount =
      platform === undefined || platform === "android" ? pendingAndroidRecoveryCount : 0;
    return pooledDeviceCount + eligibleRecoveryCount >= requiredCount;
  }

  /**
   * Whether a device image can be booted right now.
   */
  isStartableDeviceImage(image: DeviceInfo): boolean {
    if (image.isAvailable === false) {
      return false;
    }
    if (image.platform === "ios") {
      if (!image.deviceId) {
        return false;
      }
      if (image.state && image.state !== "Shutdown") {
        return false;
      }
    }
    return true;
  }

  /**
   * Stable identity key for a device image, used to avoid starting the same
   * image twice within an allocation pass.
   */
  getDeviceImageKey(image: DeviceInfo): string {
    return image.deviceId ?? `${image.platform}:${image.name}`;
  }

  /**
   * Merge image metadata onto a freshly booted device, backfilling fields the
   * boot path left unset (iOS version, screen geometry, simulator type).
   */
  withDeviceImageMetadata(ready: BootedDevice, image: DeviceInfo): DevicePoolBootedDevice {
    const imageIosVersion =
      image.iosVersion ?? image.osVersion ?? this.iosVersionFromRuntime(image.runtime);
    return {
      ...ready,
      iosVersion: ready.iosVersion ?? imageIosVersion,
      osVersion: ready.osVersion ?? image.osVersion ?? imageIosVersion,
      formFactor: ready.formFactor ?? image.formFactor,
      screenWidth: ready.screenWidth ?? image.screenWidth,
      screenHeight: ready.screenHeight ?? image.screenHeight,
      simulatorType: this.displayNameFromIosDeviceType(image.deviceType),
    };
  }

  /**
   * Derive a human-readable simulator type for a booted device.
   */
  getBootedDeviceSimulatorType(device: BootedDevice): string | undefined {
    const deviceWithPoolMetadata = device as DevicePoolBootedDevice;
    return (
      deviceWithPoolMetadata.simulatorType ??
      this.displayNameFromIosDeviceType(deviceWithPoolMetadata.deviceType)
    );
  }

  /**
   * Render criteria as a short suffix for error and log messages.
   */
  formatCriteriaSummary(criteria?: DeviceAllocationCriteria): string {
    if (!criteria) {
      return "";
    }
    const parts: string[] = [];
    if (criteria.platform) {
      parts.push(`platform=${criteria.platform}`);
    }
    if (criteria.simulatorType) {
      parts.push(`simulatorType=${criteria.simulatorType}`);
    }
    if (criteria.iosVersion) {
      parts.push(`iosVersion=${criteria.iosVersion}`);
    }
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
  }

  private normalizeValue(value?: string): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
  }

  private displayNameFromIosDeviceType(deviceType?: string): string | undefined {
    if (!deviceType) {
      return undefined;
    }
    const suffix = deviceType.split(".").pop();
    return suffix?.replace(/-/g, " ");
  }

  private iosVersionFromRuntime(runtime?: string): string | undefined {
    const match = runtime?.match(/iOS[-_](\d+(?:[-_]\d+)*)/);
    return match?.[1].replace(/[-_]/g, ".");
  }
}
