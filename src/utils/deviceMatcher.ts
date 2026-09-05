import type { BootedDevice, DeviceInfo, Platform } from "../models";
import type {
  DeviceMatchCriteria,
  FormFactor,
  MatchingStrategy,
} from "../models/DeviceMatchCriteria";
import { defaultRandom, type Random } from "./Random";

/** Selects a booted device or device image for one boot request. */
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

interface ParsedDeviceVersion {
  components: number[];
  /** A trailing single-letter release qualifier, e.g. Android 12L's "L" (#6132 follow-up). */
  letter?: string;
  qpr?: number;
}

function parseDeviceVersion(version: string): ParsedDeviceVersion | null {
  const match = /^(\d+(?:\.\d+)*)([A-Za-z])?(?:-QPR(\d+))?$/i.exec(version.trim());
  if (!match) {
    return null;
  }
  return {
    components: match[1].split(".").map(Number),
    ...(match[2] === undefined ? {} : { letter: match[2].toUpperCase() }),
    ...(match[3] === undefined ? {} : { qpr: Number(match[3]) }),
  };
}

function compareParsedVersions(partsA: number[], partsB: number[]): number {
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index++) {
    const delta = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

/**
 * Orders a trailing release-qualifier letter such as Android 12L's "L": a
 * release with no letter sorts before one with a letter at the same numeric
 * components (Android 12 < 12L), and letters otherwise sort alphabetically.
 * This is a generic string-ordering rule, not an Android-specific codename
 * table -- it works for any single trailing letter without knowing what it
 * means.
 */
function compareLetterQualifier(letterA: string | undefined, letterB: string | undefined): number {
  if (letterA === letterB) {
    return 0;
  }
  if (letterA === undefined) {
    return -1;
  }
  if (letterB === undefined) {
    return 1;
  }
  return letterA < letterB ? -1 : 1;
}

/** Compares strictly numeric dotted version components and returns NaN for other formats. */
export function compareStrictNumericVersions(a: string, b: string): number {
  if (
    ![a, b].every((version) => version.split(".").every((component) => /^\d+$/.test(component)))
  ) {
    return Number.NaN;
  }
  return compareParsedVersions(a.split(".").map(Number), b.split(".").map(Number));
}

export function compareVersions(a: string, b: string): number {
  const parsedA = parseDeviceVersion(a);
  const parsedB = parseDeviceVersion(b);
  if (parsedA && parsedB) {
    const delta = compareParsedVersions(parsedA.components, parsedB.components);
    if (delta !== 0) {
      return delta;
    }
    const letterDelta = compareLetterQualifier(parsedA.letter, parsedB.letter);
    if (letterDelta !== 0) {
      return letterDelta;
    }
    return (parsedA.qpr ?? 0) - (parsedB.qpr ?? 0);
  }
  if (parsedA || parsedB) {
    return Number.NaN;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function matchesCriteria(
  item: {
    platform: Platform;
    name: string;
    osVersion?: string;
    formFactor?: FormFactor;
    screenWidth?: number;
    screenHeight?: number;
  },
  criteria: DeviceMatchCriteria,
): boolean {
  return (
    matchesPlatform(item, criteria) &&
    matchesVersionRange(item, criteria) &&
    matchesName(item, criteria) &&
    matchesFormFactor(item, criteria) &&
    matchesScreenSize(item, criteria)
  );
}

function matchesPlatform(item: { platform: Platform }, criteria: DeviceMatchCriteria): boolean {
  return item.platform === criteria.platform;
}

function matchesVersionRange(item: { osVersion?: string }, criteria: DeviceMatchCriteria): boolean {
  const version = item.osVersion;
  const meetsMinimum =
    !criteria.minOsVersion ||
    Boolean(version && compareVersionToBound(version, criteria.minOsVersion) >= 0);
  const meetsMaximum =
    !criteria.maxOsVersion ||
    Boolean(version && compareVersionToBound(version, criteria.maxOsVersion) <= 0);
  return meetsMinimum && meetsMaximum;
}

function compareVersionToBound(version: string, bound: string): number {
  const parsedVersion = parseDeviceVersion(version);
  const parsedBound = parseDeviceVersion(bound);
  if (parsedVersion && parsedBound) {
    // A major-only bound ("8", one component, no dot) spans every point
    // release of that major (8.0, 8.1, ...), matching
    // AvdConfigReader.versionToApiLevelRange, which resolves such a bound to
    // the full API-level span for the major release when provisioning
    // (#6132). Comparing only the version's leading component against it --
    // instead of zero-padding the bound out to the version's length --
    // keeps "8.1" equal to "8", so a matcher against maxOsVersion:"8"
    // accepts an AVD that provisioning widened to 8.1 instead of rejecting
    // it and re-provisioning forever.
    //
    // A bound with its own dotted precision (e.g. "17.2") is NOT widened
    // this way: it names an exact inclusive endpoint, so "17.2.1" must
    // still compare greater than it and be rejected by a maxOsVersion of
    // "17.2" (regression caught in review: widening every bound made a
    // dotted maxOsVersion match any longer version sharing its prefix). A
    // lettered bound (e.g. "12L") is likewise an exact endpoint, not a
    // major to widen -- it has its own single component, so slicing is a
    // no-op for it and the letter tiebreak below does the real work.
    const isMajorOnlyBound =
      parsedBound.components.length === 1 && parsedBound.letter === undefined;
    const comparableVersion = isMajorOnlyBound
      ? parsedVersion.components.slice(0, 1)
      : parsedVersion.components;
    const delta = compareParsedVersions(comparableVersion, parsedBound.components);
    if (delta !== 0) {
      return delta;
    }
    // Always compare the letter qualifier, even under major-only widening:
    // Android 12L (letter "L") must still sort above a plain "12" bound and
    // below "13" (#6132 follow-up) rather than being swallowed as equal to
    // every unlettered point release of major 12.
    const letterDelta = compareLetterQualifier(parsedVersion.letter, parsedBound.letter);
    if (letterDelta !== 0) {
      return letterDelta;
    }
    if (parsedBound.qpr === undefined) {
      return 0;
    }
    return (parsedVersion.qpr ?? 0) - parsedBound.qpr;
  }
  return compareVersions(version, bound);
}

function matchesName(item: { name: string }, criteria: DeviceMatchCriteria): boolean {
  return !criteria.name || item.name.toLowerCase().includes(criteria.name.toLowerCase());
}

function matchesFormFactor(
  item: { formFactor?: FormFactor },
  criteria: DeviceMatchCriteria,
): boolean {
  return !criteria.formFactor || item.formFactor === criteria.formFactor;
}

function matchesScreenSize(
  item: { screenWidth?: number; screenHeight?: number },
  criteria: DeviceMatchCriteria,
): boolean {
  if (!criteria.screenSize) {
    return true;
  }
  if (item.screenWidth === undefined || item.screenHeight === undefined) {
    return false;
  }
  const widthRatio =
    Math.abs(item.screenWidth - criteria.screenSize.width) / criteria.screenSize.width;
  const heightRatio =
    Math.abs(item.screenHeight - criteria.screenSize.height) / criteria.screenSize.height;
  return widthRatio <= 0.1 && heightRatio <= 0.1;
}

function prefersNumericVersion<T extends { osVersion?: string }>(
  candidate: T,
  current: T,
): boolean {
  return (
    parseDeviceVersion(candidate.osVersion ?? "") !== null &&
    parseDeviceVersion(current.osVersion ?? "") === null
  );
}

function applyStrategy<T extends { osVersion?: string }>(
  candidates: T[],
  strategy: MatchingStrategy,
  random: Random,
): T | null {
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (strategy === "RANDOM") {
    return random.pick(candidates);
  }

  const wantLatest = strategy === "LATEST";
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const delta = compareVersions(candidate.osVersion ?? "0", best.osVersion ?? "0");
    if (Number.isNaN(delta)) {
      if (prefersNumericVersion(candidate, best)) {
        best = candidate;
      }
      continue;
    }
    if (wantLatest ? delta > 0 : delta < 0) {
      best = candidate;
    }
  }
  return best;
}

export class DefaultDeviceMatcher implements DeviceMatcher {
  constructor(private readonly random: Random = defaultRandom) {}

  matchBootedDevice(
    criteria: DeviceMatchCriteria,
    devices: BootedDevice[],
    strategy: MatchingStrategy,
  ): BootedDevice | null {
    return applyStrategy(
      devices.filter((device) => matchesCriteria(device, criteria)),
      strategy,
      this.random,
    );
  }

  matchDeviceImage(
    criteria: DeviceMatchCriteria,
    images: DeviceInfo[],
    strategy: MatchingStrategy,
  ): DeviceInfo | null {
    return applyStrategy(
      images.filter((image) => matchesCriteria(image, criteria)),
      strategy,
      this.random,
    );
  }
}
