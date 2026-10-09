import type { AppleDeviceType } from "./SimCtlClient";
import {
  compareSimctlVersions,
  decodeSimctlVersion,
  parseSimctlVersion,
  type SimctlVersionTuple,
} from "./simctlVersion";

/**
 * Shared simulator model/runtime compatibility policy. Catalog projection,
 * criteria-based selection, and exact provisioning all go through this module so
 * they agree on what "supported", "unsupported", and "unknown" mean.
 */
export type RuntimeCompatibilityStatus = "supported" | "unsupported" | "unknown";

/** JSON-safe inclusive bounds; `maxVersion: null` is an unbounded maximum. */
export interface DeviceTypeRuntimeBounds {
  minVersion: string;
  maxVersion: string | null;
}

export interface RuntimeCompatibilityEvaluation {
  status: RuntimeCompatibilityStatus;
  bounds?: DeviceTypeRuntimeBounds;
  /** Why the status is `unknown`/`unsupported` when it is not obvious from the bounds. */
  reason?: string;
}

interface ResolvedBounds {
  min: SimctlVersionTuple;
  max: SimctlVersionTuple;
}

export function formatSimctlVersion(version: SimctlVersionTuple): string {
  return `${version[0]}.${version[1]}.${version[2]}`;
}

/**
 * Legacy CoreSimulator output with no range metadata at all (no strings and
 * zero packed bounds) carries no evidence either way.
 */
export function hasRuntimeRangeMetadata(deviceType: AppleDeviceType): boolean {
  return (
    deviceType.minRuntimeVersionString !== undefined ||
    deviceType.maxRuntimeVersionString !== undefined ||
    deviceType.minRuntimeVersion !== 0 ||
    deviceType.maxRuntimeVersion !== 0
  );
}

/** A present-but-unparseable string is malformed evidence, not a cue to fall back to the packed value. */
function resolveVersion(
  text: string | undefined,
  packed: number | undefined,
): SimctlVersionTuple | undefined {
  return text !== undefined ? parseSimctlVersion(text) : decodeSimctlVersion(packed);
}

function resolveBounds(deviceType: AppleDeviceType): ResolvedBounds | undefined {
  if (!hasRuntimeRangeMetadata(deviceType)) {
    return undefined;
  }
  const min = resolveVersion(deviceType.minRuntimeVersionString, deviceType.minRuntimeVersion);
  const max = resolveVersion(deviceType.maxRuntimeVersionString, deviceType.maxRuntimeVersion);
  return min && max && compareSimctlVersions(min, max) <= 0 ? { min, max } : undefined;
}

/** CoreSimulator spells "no maximum" as packed 0xffffffff, i.e. string 65535.255.255. */
const UNBOUNDED_MAX_SENTINEL: SimctlVersionTuple = [65535, 255, 255];

function isUnboundedMax(max: SimctlVersionTuple): boolean {
  return !Number.isFinite(max[0]) || compareSimctlVersions(max, UNBOUNDED_MAX_SENTINEL) >= 0;
}

function projectBounds(bounds: ResolvedBounds): DeviceTypeRuntimeBounds {
  return {
    minVersion: formatSimctlVersion(bounds.min),
    maxVersion: isUnboundedMax(bounds.max) ? null : formatSimctlVersion(bounds.max),
  };
}

/** Normalized inclusive bounds, or undefined when missing or malformed. */
export function deviceTypeRuntimeBounds(
  deviceType: AppleDeviceType,
): DeviceTypeRuntimeBounds | undefined {
  const bounds = resolveBounds(deviceType);
  return bounds ? projectBounds(bounds) : undefined;
}

export function evaluateRuntimeCompatibility(
  deviceType: AppleDeviceType,
  runtimeVersion: string | undefined,
): RuntimeCompatibilityEvaluation {
  const bounds = resolveBounds(deviceType);
  if (!bounds) {
    return {
      status: "unknown",
      reason: hasRuntimeRangeMetadata(deviceType)
        ? "device type runtime range is malformed"
        : "device type has no runtime range metadata",
    };
  }
  const projected = projectBounds(bounds);
  const runtime = parseSimctlVersion(runtimeVersion);
  if (!runtime) {
    return {
      status: "unknown",
      bounds: projected,
      reason: "runtime version is missing or malformed",
    };
  }
  const inside =
    compareSimctlVersions(runtime, bounds.min) >= 0 &&
    compareSimctlVersions(runtime, bounds.max) <= 0;
  return { status: inside ? "supported" : "unsupported", bounds: projected };
}
