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
 * every platform uniformly rather than special-casing iOS. Apple Watch simulators have their own
 * source: an iOS sweep never lists them, so it can never prove a watch is gone (#14908).
 */
export type DiscoverySource = "android" | "ios-simulator" | "ios-physical" | "watchos-simulator";

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
  if (platform === "watchos") {
    return "watchos-simulator";
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
  switch (platform) {
    case "android":
      return ["android"];
    case "ios":
      return ["ios-simulator", "ios-physical"];
    case "watchos":
      return ["watchos-simulator"];
    case "tvos":
      // Apple TV simulators are not discovered yet: no source sweeps them.
      return [];
  }
}

function platformForSource(source: DiscoverySource): Platform {
  switch (source) {
    case "android":
      return "android";
    case "watchos-simulator":
      return "watchos";
    case "ios-simulator":
    case "ios-physical":
      return "ios";
  }
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

/**
 * What one discovery source says about this host this sweep (#11605):
 * - `complete`: it ran and listed its devices (possibly none);
 * - `not_applicable`: its tooling is not installed or does not exist on this host (no adb binary,
 *   not macOS, no Xcode/simctl, no devicectl). Its device count is a true zero, it never makes an
 *   observation incomplete, and retrying cannot change it;
 * - `incomplete`: it exists and failed, timed out, or was not asked. The answer is unknown.
 */
export type DiscoverySourceOutcome = "complete" | "not_applicable" | "incomplete";

/** The parts of a discovery result the per-source classifier reads. */
export interface DiscoverySourceEvidence extends DiscoveryCompleteness {
  sourceErrors?: Partial<Record<DiscoverySource, { code: string }>>;
  discoveryErrors?: Partial<Record<Platform, { code: string }>>;
  /**
   * Sources this host is known to have, because a pooled device was listed through them. Their
   * tooling reporting "not installed" now (adb replaced mid-upgrade, the active Xcode switched)
   * is an unknown about devices that existed, never a true zero. See {@link expectingPooledSources}.
   */
  expectedSources?: ReadonlySet<DiscoverySource>;
}

/**
 * The same discovery result, with every source a pooled device depends on marked as expected: a
 * pooled entry is proof the tooling existed on this host, so its devices are not "not applicable".
 */
export function expectingPooledSources<T extends DiscoverySourceEvidence>(
  discovery: T,
  pooled: Iterable<{ platform: Platform; id: string }> | undefined,
): T {
  const expectedSources = new Set(discovery.expectedSources);
  for (const device of pooled ?? []) {
    expectedSources.add(discoverySourceFor(device.platform, device.id));
  }
  return { ...discovery, expectedSources };
}

/**
 * The one classifier every inventory surface asks. "Not installed" is read from the typed
 * `unavailable` error the producer derived from the tool invocation itself (ENOENT / the tool's
 * own "not found" report), never guessed from the host platform here. A source with no error of
 * its own inherits its platform's error: without Xcode neither iOS source ran. A source a pooled
 * device depends on (`expectedSources`) is never not applicable.
 */
export function discoverySourceOutcome(
  discovery: DiscoverySourceEvidence,
  source: DiscoverySource,
): DiscoverySourceOutcome {
  const platform = platformForSource(source);
  const succeeded = discovery.succeededSources
    ? discovery.succeededSources.has(source)
    : discovery.succeededPlatforms.has(platform);
  if (succeeded) {
    return "complete";
  }
  const error = discovery.sourceErrors?.[source] ?? discovery.discoveryErrors?.[platform];
  return error?.code === "unavailable" && !discovery.expectedSources?.has(source)
    ? "not_applicable"
    : "incomplete";
}

function sourcesWithOutcome(
  discovery: DiscoverySourceEvidence,
  platforms: readonly Platform[],
  outcome: DiscoverySourceOutcome,
): DiscoverySource[] {
  return platforms
    .flatMap((platform) => sourcesForPlatform(platform))
    .filter((source) => discoverySourceOutcome(discovery, source) === outcome);
}

/** The requested platforms' sources whose answer is unknown; none means the observation is complete. */
export function incompleteDiscoverySources(
  discovery: DiscoverySourceEvidence,
  platforms: readonly Platform[],
): DiscoverySource[] {
  return sourcesWithOutcome(discovery, platforms, "incomplete");
}

/** The requested platforms' sources whose tooling this host does not have. */
export function notApplicableDiscoverySources(
  discovery: DiscoverySourceEvidence,
  platforms: readonly Platform[],
): DiscoverySource[] {
  return sourcesWithOutcome(discovery, platforms, "not_applicable");
}

/**
 * True when this device's absence is unknown rather than proven: the source that would have
 * listed it exists on this host and did not complete. A source that is not installed cannot list
 * the device on any retry, so its silence is not an unknown.
 */
export function isDeviceSourceIncomplete(
  discovery: DiscoverySourceEvidence,
  platform: Platform,
  deviceId: string | undefined,
): boolean {
  return discoverySourceOutcome(discovery, discoverySourceFor(platform, deviceId)) === "incomplete";
}
