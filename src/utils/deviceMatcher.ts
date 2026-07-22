import type { BootedDevice, DeviceInfo, Platform } from "../models";
import type { DeviceMatchCriteria, FormFactor, MatchingStrategy } from "../models/DeviceMatchCriteria";
import { defaultRandom, type Random } from "./Random";

/** Selects a booted device or device image for one boot request. */
export interface DeviceMatcher {
  matchBootedDevice(criteria: DeviceMatchCriteria, devices: BootedDevice[], strategy: MatchingStrategy): BootedDevice | null;
  matchDeviceImage(criteria: DeviceMatchCriteria, images: DeviceInfo[], strategy: MatchingStrategy): DeviceInfo | null;
}

function parseVersion(version: string): number[] {
  return version.split(".").map(Number);
}

function compareParsedVersions(partsA: number[], partsB: number[]): number {
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index++) {
    const delta = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (delta !== 0) { return delta; }
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  return compareParsedVersions(parseVersion(a), parseVersion(b));
}

function matchesCriteria(
  item: { platform: Platform; name: string; osVersion?: string; formFactor?: FormFactor; screenWidth?: number; screenHeight?: number },
  criteria: DeviceMatchCriteria,
): boolean {
  return matchesPlatform(item, criteria) &&
    matchesVersionRange(item, criteria) &&
    matchesName(item, criteria) &&
    matchesFormFactor(item, criteria) &&
    matchesScreenSize(item, criteria);
}

function matchesPlatform(item: { platform: Platform }, criteria: DeviceMatchCriteria): boolean {
  return item.platform === criteria.platform;
}

function matchesVersionRange(item: { osVersion?: string }, criteria: DeviceMatchCriteria): boolean {
  const version = item.osVersion;
  const meetsMinimum = !criteria.minOsVersion || Boolean(version && compareVersions(version, criteria.minOsVersion) >= 0);
  const meetsMaximum = !criteria.maxOsVersion || Boolean(version && compareVersions(version, criteria.maxOsVersion) <= 0);
  return meetsMinimum && meetsMaximum;
}

function matchesName(item: { name: string }, criteria: DeviceMatchCriteria): boolean {
  return !criteria.name || item.name.toLowerCase().includes(criteria.name.toLowerCase());
}

function matchesFormFactor(item: { formFactor?: FormFactor }, criteria: DeviceMatchCriteria): boolean {
  return !criteria.formFactor || item.formFactor === criteria.formFactor;
}

function matchesScreenSize(item: { screenWidth?: number; screenHeight?: number }, criteria: DeviceMatchCriteria): boolean {
  if (!criteria.screenSize) { return true; }
  if (item.screenWidth === undefined || item.screenHeight === undefined) { return false; }
  const widthRatio = Math.abs(item.screenWidth - criteria.screenSize.width) / criteria.screenSize.width;
  const heightRatio = Math.abs(item.screenHeight - criteria.screenSize.height) / criteria.screenSize.height;
  return widthRatio <= 0.1 && heightRatio <= 0.1;
}

function applyStrategy<T extends { osVersion?: string }>(candidates: T[], strategy: MatchingStrategy, random: Random): T | null {
  if (candidates.length === 0) { return null; }
  if (candidates.length === 1) { return candidates[0]; }
  if (strategy === "RANDOM") { return random.pick(candidates); }

  const wantLatest = strategy === "LATEST";
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const delta = compareVersions(candidate.osVersion ?? "0", best.osVersion ?? "0");
    if (wantLatest ? delta > 0 : delta < 0) { best = candidate; }
  }
  return best;
}

export class DefaultDeviceMatcher implements DeviceMatcher {
  constructor(private readonly random: Random = defaultRandom) {}

  matchBootedDevice(criteria: DeviceMatchCriteria, devices: BootedDevice[], strategy: MatchingStrategy): BootedDevice | null {
    return applyStrategy(devices.filter(device => matchesCriteria(device, criteria)), strategy, this.random);
  }

  matchDeviceImage(criteria: DeviceMatchCriteria, images: DeviceInfo[], strategy: MatchingStrategy): DeviceInfo | null {
    return applyStrategy(images.filter(image => matchesCriteria(image, criteria)), strategy, this.random);
  }
}
