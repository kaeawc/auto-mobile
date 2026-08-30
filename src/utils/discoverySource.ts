import type { Platform } from "../models/Platform";
import { isIosPhysicalUdid } from "./ios-cmdline-tools/iosDeviceType";

/**
 * A single discovery mechanism, one level below `Platform`.
 *
 * iOS has two independent sources — `simctl` for booted simulators and
 * `devicectl` for connected physical devices (#5620) — and either can fail
 * while the other reports a device it directly observed. A per-platform
 * "succeeded" flag cannot express that: tying it to devicectl made a blip
 * strip every idle simulator of its liveness proof, and tying it to simctl
 * alone (what #5682 shipped) left a confirmed iPhone unassignable whenever
 * simctl failed. Carrying completeness per source removes the tension (#5683).
 *
 * Android has exactly one source today; it is named here so callers can treat
 * every platform uniformly rather than special-casing iOS.
 */
export type DiscoverySource = "android" | "ios-simulator" | "ios-physical";

/**
 * The source that would have observed this device.
 *
 * The UDID shape is the same runtime signal the iOS tooling already uses to
 * route between `simctl` and `devicectl`, so classification here cannot drift
 * from the command that actually ran. An iOS device with no id at all is
 * attributed to the simulator source, which is the conservative default: it is
 * the source whose failure already suppresses pruning.
 */
export function discoverySourceFor(
  platform: Platform,
  deviceId: string | undefined,
): DiscoverySource {
  if (platform === "android") {
    return "android";
  }
  return deviceId !== undefined && isIosPhysicalUdid(deviceId) ? "ios-physical" : "ios-simulator";
}

/**
 * The discovery sources that make up a platform's sweep.
 *
 * Android has one; iOS has two independent sources (`simctl` and `devicectl`),
 * so a per-platform completeness flag cannot express which half of a mixed
 * outcome is authoritative (#5683). A consumer that reports completeness per
 * source enumerates a platform's sources through this.
 */
export function sourcesForPlatform(platform: Platform): DiscoverySource[] {
  return platform === "android" ? ["android"] : ["ios-simulator", "ios-physical"];
}

/** The completeness half of a discovery result, per platform and per source. */
export interface DiscoveryCompleteness {
  succeededPlatforms: ReadonlySet<Platform>;
  /**
   * Sources whose sweep completed. Optional so a producer that predates
   * per-source reporting (or a fake that does not model it) still resolves
   * through the platform aggregate below.
   */
  succeededSources?: ReadonlySet<DiscoverySource>;
}

/**
 * True when the source that would have observed this device completed its
 * sweep, so its silence about the device is evidence the device is gone.
 *
 * False means "we could not find out" — never "it disconnected".
 */
export function didSourceSucceedForDevice(
  completeness: DiscoveryCompleteness,
  platform: Platform,
  deviceId: string | undefined,
): boolean {
  const sources = completeness.succeededSources;
  if (sources) {
    return sources.has(discoverySourceFor(platform, deviceId));
  }
  return completeness.succeededPlatforms.has(platform);
}
