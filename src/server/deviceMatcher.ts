import type { BootedDevice, DeviceInfo, Platform } from "../models";
import type { DeviceMatchCriteria, FormFactor, MatchingStrategy } from "../models/DeviceMatchCriteria";
import { defaultRandom, type Random } from "../utils/Random";

/**
 * Interface for matching devices against criteria.
 */
export interface DeviceMatcher {
  matchBootedDevice(
    criteria: DeviceMatchCriteria,
    devices: BootedDevice[],
    strategy: MatchingStrategy,
  ): BootedDevice | null;

  matchDeviceImage(
    criteria: DeviceMatchCriteria,
    images: DeviceInfo[],
    strategy: MatchingStrategy,
  ): DeviceInfo | null;
}

/**
 * Compare two version strings using semver-like logic.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va !== vb) {return va - vb;}
  }
  return 0;
}

function matchesPlatform<T extends { platform: Platform }>(item: T, platform: Platform): boolean {
  return item.platform === platform;
}

function matchesMinOsVersion(itemVersion: string | undefined, minVersion: string): boolean {
  if (!itemVersion) {return false;}
  return compareVersions(itemVersion, minVersion) >= 0;
}

function matchesMaxOsVersion(itemVersion: string | undefined, maxVersion: string): boolean {
  if (!itemVersion) {return false;}
  return compareVersions(itemVersion, maxVersion) <= 0;
}

function matchesName(itemName: string, pattern: string): boolean {
  return itemName.toLowerCase().includes(pattern.toLowerCase());
}

function matchesFormFactor(itemFormFactor: FormFactor | undefined, required: FormFactor): boolean {
  return itemFormFactor === required;
}

function matchesScreenSize(
  itemWidth: number | undefined,
  itemHeight: number | undefined,
  targetWidth: number,
  targetHeight: number,
  tolerance: number = 0.1,
): boolean {
  if (itemWidth === null || itemWidth === undefined || itemHeight === null || itemHeight === undefined) {return false;}
  const widthRatio = Math.abs(itemWidth - targetWidth) / targetWidth;
  const heightRatio = Math.abs(itemHeight - targetHeight) / targetHeight;
  return widthRatio <= tolerance && heightRatio <= tolerance;
}

function matchesCriteria<T extends { platform: Platform; name: string; osVersion?: string; formFactor?: FormFactor; screenWidth?: number; screenHeight?: number }>(
  d: T,
  criteria: DeviceMatchCriteria,
): boolean {
  if (!matchesPlatform(d, criteria.platform)) {return false;}
  if (criteria.minOsVersion && !matchesMinOsVersion(d.osVersion, criteria.minOsVersion)) {return false;}
  if (criteria.maxOsVersion && !matchesMaxOsVersion(d.osVersion, criteria.maxOsVersion)) {return false;}
  if (criteria.name && !matchesName(d.name, criteria.name)) {return false;}
  if (criteria.formFactor && !matchesFormFactor(d.formFactor, criteria.formFactor)) {return false;}
  if (criteria.screenSize && !matchesScreenSize(d.screenWidth, d.screenHeight, criteria.screenSize.width, criteria.screenSize.height)) {return false;}
  return true;
}

function applyStrategy<T extends { osVersion?: string }>(
  candidates: T[],
  strategy: MatchingStrategy,
  random: Random,
): T | null {
  if (candidates.length === 0) {return null;}
  if (candidates.length === 1) {return candidates[0];}

  switch (strategy) {
    case "LATEST":
      return [...candidates].sort((a, b) =>
        compareVersions(b.osVersion ?? "0", a.osVersion ?? "0")
      )[0];
    case "MINIMUM":
      return [...candidates].sort((a, b) =>
        compareVersions(a.osVersion ?? "0", b.osVersion ?? "0")
      )[0];
    case "RANDOM":
      return random.pick(candidates);
  }
}

/**
 * Default device matcher implementation.
 */
export class DefaultDeviceMatcher implements DeviceMatcher {
  constructor(private readonly random: Random = defaultRandom) {}

  matchBootedDevice(
    criteria: DeviceMatchCriteria,
    devices: BootedDevice[],
    strategy: MatchingStrategy,
  ): BootedDevice | null {
    const filtered = devices.filter(d => matchesCriteria(d, criteria));
    return applyStrategy(filtered, strategy, this.random);
  }

  matchDeviceImage(
    criteria: DeviceMatchCriteria,
    images: DeviceInfo[],
    strategy: MatchingStrategy,
  ): DeviceInfo | null {
    const filtered = images.filter(d => matchesCriteria(d, criteria));
    return applyStrategy(filtered, strategy, this.random);
  }
}
