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

export interface ParsedDeviceVersion {
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

/**
 * Orders the numeric-components-then-letter prefix shared by `compareVersions`
 * (a strict total order used to pick LATEST/MINIMUM) and `compareVersionToBound`
 * (bound semantics, which may separately widen or ignore a QPR suffix
 * depending on the bound's own precision). Extracted so the two QPR-handling
 * call sites can't drift out of sync on how components and the letter
 * qualifier order against each other (#6182).
 */
function compareComponentsThenLetter(
  componentsA: number[],
  letterA: string | undefined,
  componentsB: number[],
  letterB: string | undefined,
): number {
  const componentsDelta = compareParsedVersions(componentsA, componentsB);
  if (componentsDelta !== 0) {
    return componentsDelta;
  }
  return compareLetterQualifier(letterA, letterB);
}

/**
 * Total ordering over a parsed Android release qualifier's (components,
 * letter, qpr) triple: numeric dotted components take precedence, then the
 * trailing letter qualifier (Android 12L), then the QPR suffix. A missing
 * letter or QPR sorts before any present value, so `11 < 12 < 12L < 13` and
 * `14 < 14-QPR1 < 14-QPR2` (#6182).
 *
 * This is a general total order over the triple -- it does NOT claim to
 * encode Android's actual release calendar for comparing a letter release
 * against a QPR release of the same major (e.g. `12L` vs `12-QPR1`); that
 * relationship is undocumented and explicitly out of scope (see the tracking
 * issue). The rule adopted here -- the letter qualifier outranks the QPR
 * qualifier -- exists only to keep the relation total, reflexive, antisymmetric
 * and transitive over every input this parser accepts, not to assert calendar
 * accuracy for that specific pairing.
 */
export function compareReleaseQualifiers(a: ParsedDeviceVersion, b: ParsedDeviceVersion): number {
  const delta = compareComponentsThenLetter(a.components, a.letter, b.components, b.letter);
  if (delta !== 0) {
    return delta;
  }
  return (a.qpr ?? 0) - (b.qpr ?? 0);
}

export function compareVersions(a: string, b: string): number {
  const parsedA = parseDeviceVersion(a);
  const parsedB = parseDeviceVersion(b);
  if (parsedA && parsedB) {
    return compareReleaseQualifiers(parsedA, parsedB);
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

function matchesVersionRange(
  item: { platform: Platform; osVersion?: string },
  criteria: DeviceMatchCriteria,
): boolean {
  const version = item.osVersion;
  const meetsMinimum =
    !criteria.minOsVersion ||
    Boolean(version && compareVersionToBound(version, criteria.minOsVersion, item.platform) >= 0);
  const meetsMaximum =
    !criteria.maxOsVersion ||
    Boolean(version && compareVersionToBound(version, criteria.maxOsVersion, item.platform) <= 0);
  return meetsMinimum && meetsMaximum;
}

function compareVersionToBound(version: string, bound: string, platform: Platform): number {
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
    // it and re-provisioning forever. This API-level range expansion is an
    // Android-only concept (there is no iOS equivalent table), so the
    // widening is gated to platform === "android" -- an iOS maxOsVersion of
    // "17" is an exact inclusive maximum and "17.6" is genuinely newer and
    // must be rejected, not treated as "every 17.x" (regression caught in
    // review).
    //
    // A bound with its own dotted precision (e.g. "17.2") is NOT widened
    // this way: it names an exact inclusive endpoint, so "17.2.1" must
    // still compare greater than it and be rejected by a maxOsVersion of
    // "17.2" (regression caught in review: widening every bound made a
    // dotted maxOsVersion match any longer version sharing its prefix). A
    // lettered bound (e.g. "12L") is likewise an exact endpoint, not a
    // major to widen -- it has its own single component, so slicing is a
    // no-op for it and the letter tiebreak below does the real work. A QPR
    // bound (e.g. "14-QPR1") must be excluded from widening too, even though
    // it also has exactly one numeric component: without this guard "14.1"
    // would slice down to "14" and false-match a "14-QPR1" bound it has
    // nothing to do with (review follow-up, generalized into
    // compareReleaseQualifiers by #6182).
    const isMajorOnlyBound =
      platform === "android" &&
      parsedBound.components.length === 1 &&
      parsedBound.letter === undefined &&
      parsedBound.qpr === undefined;
    const comparableVersion = isMajorOnlyBound
      ? parsedVersion.components.slice(0, 1)
      : parsedVersion.components;
    // Components and the letter qualifier always compare the same way here as
    // in compareVersions/compareReleaseQualifiers (Android 12L must still
    // sort above a plain "12" bound and below "13" -- #6132 follow-up --
    // rather than being swallowed as equal to every unlettered point release
    // of major 12); only the QPR handling below diverges, because a bound
    // that doesn't name a QPR is deliberately QPR-agnostic rather than
    // treating "no QPR" as QPR 0 (#6182).
    const delta = compareComponentsThenLetter(
      comparableVersion,
      parsedVersion.letter,
      parsedBound.components,
      parsedBound.letter,
    );
    if (delta !== 0) {
      return delta;
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
