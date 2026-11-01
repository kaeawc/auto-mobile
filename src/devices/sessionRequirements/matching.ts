import { iosModelTypeMatches } from "./catalog";
import type {
  AndroidSessionDeviceProfile,
  DevicePredicateMatch,
  IosSessionDeviceProfile,
  NormalizedAndroidSessionDeviceRequirement,
  NormalizedIosSessionDeviceRequirement,
  NormalizedSessionDeviceRequirement,
  SessionDeviceProfile,
} from "./types";
import { androidOsEvidenceMatches, osSelectorMatchesVersion, parseNumericVersion } from "./version";

const MATCH: DevicePredicateMatch = { kind: "match" };

function mismatch(reason: Exclude<DevicePredicateMatch, { kind: "match" }>["reason"]) {
  return { kind: "mismatch" as const, reason };
}

function matchIosHardware(
  requirement: NormalizedIosSessionDeviceRequirement,
  candidate: IosSessionDeviceProfile,
): DevicePredicateMatch {
  const selector = requirement.effective.hardware;
  if (selector.kind === "exact-model") {
    const model = requirement.exactModel;
    if (!model || !candidate.simulatorDeviceTypeIdentifier) {
      return mismatch("unknown-hardware-metadata");
    }
    return candidate.simulatorDeviceTypeIdentifier === model.simulatorDeviceTypeIdentifier
      ? MATCH
      : mismatch("hardware");
  }
  if (selector.kind === "model-type") {
    if (!candidate.modelType) {
      return mismatch("unknown-hardware-metadata");
    }
    return iosModelTypeMatches(selector.modelType, candidate.modelType)
      ? MATCH
      : mismatch("hardware");
  }
  if (!candidate.archetype) {
    return mismatch("unknown-hardware-metadata");
  }
  return candidate.archetype === selector.archetype ? MATCH : mismatch("hardware");
}

function matchAndroidHardware(
  requirement: NormalizedAndroidSessionDeviceRequirement,
  candidate: AndroidSessionDeviceProfile,
): DevicePredicateMatch {
  if (!candidate.archetype) {
    return mismatch("unknown-hardware-metadata");
  }
  return candidate.archetype === requirement.effective.hardware.archetype
    ? MATCH
    : mismatch("hardware");
}

function matchOs(
  requirement: NormalizedSessionDeviceRequirement,
  candidate: IosSessionDeviceProfile | AndroidSessionDeviceProfile,
): DevicePredicateMatch {
  if (!candidate.osVersion || !parseNumericVersion(candidate.osVersion).ok) {
    return mismatch("unknown-os-metadata");
  }
  if (candidate.platform === "android") {
    if (!candidate.versionPrecision) {
      return mismatch("unknown-os-metadata");
    }
    return androidOsEvidenceMatches(
      requirement.effective.os,
      candidate.osVersion,
      candidate.versionPrecision,
    )
      ? MATCH
      : mismatch("os");
  }
  return osSelectorMatchesVersion(requirement.effective.os, candidate.osVersion)
    ? MATCH
    : mismatch("os");
}

/**
 * Evaluate the normalized pool predicate. Unknown or stale metadata never
 * satisfies a request and display names are intentionally ignored.
 */
export function matchSessionDevice(
  requirement: NormalizedSessionDeviceRequirement,
  candidate: SessionDeviceProfile,
): DevicePredicateMatch {
  if (requirement.platform !== candidate.platform) {
    return mismatch("platform");
  }
  if (candidate.metadataState !== "current") {
    return mismatch("stale-metadata");
  }
  if (requirement.platform === "ios" && candidate.platform === "ios") {
    const hardware = matchIosHardware(requirement, candidate);
    return hardware.kind === "match" ? matchOs(requirement, candidate) : hardware;
  }
  if (requirement.platform === "android" && candidate.platform === "android") {
    const hardware = matchAndroidHardware(requirement, candidate);
    return hardware.kind === "match" ? matchOs(requirement, candidate) : hardware;
  }
  return mismatch("platform");
}
