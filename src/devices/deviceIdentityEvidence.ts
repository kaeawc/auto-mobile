import type { BootedDevice } from "../models";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";

export interface IdentityEvidence {
  /** A resolved identity label (e.g. AVD name), when the observation resolved one. */
  stableId?: string;
  /** The observation stamp, when known. */
  observedAt?: number;
  /** Whether this observation could not confirm an identity. */
  unresolved: boolean;
}

export type IdentityComparison = "newer" | "stale" | "unresolved-newer" | "equal";

/** Whether an Android emulator observation failed to provide an AVD identity. */
export function isUnresolvedAndroidEmulatorName(
  device: Pick<BootedDevice, "deviceId" | "name" | "platform">,
): boolean {
  return (
    device.platform === "android" &&
    isAndroidEmulatorSerial(device.deviceId) &&
    (device.name === `Unknown (${device.deviceId})` || device.name === device.deviceId)
  );
}

/**
 * Compare identity evidence for the same serial. An unstamped observation is
 * deliberately unorderable, preserving the pool's existing permissive behavior
 * for legacy/start-path snapshots.
 */
export function compareIdentityEvidence(
  current: IdentityEvidence,
  incoming: IdentityEvidence,
): IdentityComparison {
  if (current.observedAt === undefined || incoming.observedAt === undefined) {
    return "newer";
  }
  if (incoming.observedAt < current.observedAt) {
    return "stale";
  }
  if (incoming.observedAt === current.observedAt) {
    return "equal";
  }
  return incoming.unresolved && !current.unresolved ? "unresolved-newer" : "newer";
}

/** Derive evidence from one discovery observation. */
export function deriveEvidenceFromBootedDevice(
  device: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  isUnresolvedName: boolean,
): IdentityEvidence {
  const rawAndroidEmulatorSerial =
    device.platform === "android" &&
    isAndroidEmulatorSerial(device.deviceId) &&
    device.name === device.deviceId;
  const unresolved = isUnresolvedName || rawAndroidEmulatorSerial;
  return {
    ...(unresolved ? {} : { stableId: device.name }),
    ...(device.observedAt === undefined ? {} : { observedAt: device.observedAt }),
    unresolved,
  };
}

/** Derive evidence from a pooled entry's identity state. */
export function deriveEvidenceFromPooledDevice(pooled: {
  identityObservedAt?: number;
  identityUnresolved?: boolean;
}): IdentityEvidence {
  return {
    ...(pooled.identityObservedAt === undefined ? {} : { observedAt: pooled.identityObservedAt }),
    unresolved: pooled.identityUnresolved === true,
  };
}
