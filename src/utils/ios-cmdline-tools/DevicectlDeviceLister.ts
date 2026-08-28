import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ExecResult } from "../../models";
import type { BootedDevice } from "../../models/DeviceInfo";
import { errorMessage } from "../describeUnknownError";
import { DefaultHostCommandExecutor, type HostCommandOptions } from "../HostCommandExecutor";
import { logger, type Logger } from "../logger";
import { defaultTimer, type Timer } from "../SystemTimer";
import {
  defaultDiscoveryObservationSequence,
  type DiscoveryObservationSequence,
} from "../DiscoveryObservationSequence";
import { inferIosFormFactor, isIosPhysicalUdid } from "./iosDeviceType";

/**
 * Discovery seam for *physical* iOS devices attached to this host.
 *
 * Simulators come from `SimCtlClient`; this is the devicectl-backed other half,
 * so `MultiPlatformDeviceManager` can resolve a physical UDID to a
 * `BootedDevice` instead of rejecting it as "not booted" (issue #5620).
 *
 * Implementations must never throw: a host with no Xcode, no devicectl, or no
 * attached hardware degrades to an empty list.
 */
export interface IosPhysicalDeviceLister {
  listConnectedDevices(): Promise<PhysicalIosDeviceDiscovery>;
}

/**
 * Outcome of one physical-device sweep.
 *
 * `complete` is the load-bearing half: it is false ONLY when devicectl was
 * reachable but its listing could not be read in full — the invocation failed, or
 * the payload drifted — so callers can tell "no physical devices are attached"
 * from "we could not find out". The daemon's disconnect monitor prunes
 * on that distinction, and pruning a still-connected iPhone because devicectl
 * blipped would evict a device mid-session.
 *
 * A host that cannot run devicectl at all (non-darwin, no Xcode) reports
 * `complete: true`: no physical device can ever be tracked there, so their
 * absence is authoritative.
 */
export interface PhysicalIosDeviceDiscovery {
  devices: BootedDevice[];
  complete: boolean;
  /**
   * Devices in `devices` that came from the retention replay rather than this
   * sweep, so a caller can tell "still plugged in" from "last seen recently".
   *
   * `complete` alone cannot make that call in either direction: a sweep with
   * one malformed record reports `complete: false` while every listed device
   * was freshly parsed, and a failed sweep reports `complete: false` while
   * every listed device is a replay. Liveness decisions need this set; pruning
   * decisions still want `complete` (#5683).
   */
  retainedDeviceIds?: ReadonlySet<string>;
}

/**
 * `connectionProperties.tunnelState` values that mean "this device is known to
 * Xcode but is not reachable right now". Everything else — including a missing
 * or unrecognized state — is treated as connected.
 *
 * The bias is deliberate and asymmetric: the bug being fixed is a physical
 * device being wrongly rejected, so an unknown state must not re-introduce that
 * rejection. Only states devicectl documents as unreachable filter a device out.
 */
const UNREACHABLE_TUNNEL_STATES = new Set(["unavailable", "disconnected"]);

/**
 * `hardwareProperties.platform` values this lister accepts as an iOS device.
 *
 * A paired Apple Watch, Apple TV, or Vision Pro is a CoreDevice too, and they
 * use the same physical-UDID shapes — so the UDID pattern alone cannot tell them
 * apart. Without this gate they would be published as `platform: "ios"` and
 * route iOS operations to hardware that cannot serve them.
 *
 * A record with NO platform field is still accepted, keeping the same
 * degrade-toward-inclusion policy as {@link UNREACHABLE_TUNNEL_STATES}: older
 * devicectl payloads that omit the field must not lose their iPhones.
 */
const IOS_PLATFORM_VALUES = new Set(["ios", "ipados"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Pull the device array out of a `devicectl list devices --json-output` payload.
 * devicectl nests it under `result.devices`; tolerate a bare `devices` array and
 * a top-level array so a future envelope change degrades to "no devices" rather
 * than a crash.
 */
function extractDeviceEntries(data: unknown): unknown[] | null {
  if (Array.isArray(data)) {
    return data;
  }
  const root = asRecord(data);
  if (!root) {
    return null;
  }
  const outcome = asString(asRecord(root.info)?.outcome)?.toLowerCase();
  if (outcome && outcome !== "success") {
    return null;
  }
  const devices = asRecord(root.result)?.devices ?? root.devices;
  return Array.isArray(devices) ? devices : null;
}

/**
 * What one devicectl record turned out to be.
 *
 * `filtered` and `malformed` both yield no device, but they mean opposite things
 * for completeness. `filtered` is a record this lister *understands* and does not
 * want — a paired Watch, an unreachable phone — so the sweep still knows exactly
 * which iPhones are attached. `malformed` is a record it cannot identify at all,
 * which means the payload no longer matches what this parser reads and the
 * resulting device list may be missing hardware that is physically present.
 */
type DeviceEntryOutcome =
  | { kind: "device"; device: BootedDevice }
  | { kind: "filtered" }
  | { kind: "malformed" };

const FILTERED: DeviceEntryOutcome = { kind: "filtered" };
const MALFORMED: DeviceEntryOutcome = { kind: "malformed" };

/**
 * False only when the record names a platform that is not iOS. A missing field
 * passes, per the degrade-toward-inclusion policy on {@link IOS_PLATFORM_VALUES}.
 */
function isIosPlatform(hardware: Record<string, unknown> | null): boolean {
  const devicePlatform = asString(hardware?.platform)?.toLowerCase();
  return !devicePlatform || IOS_PLATFORM_VALUES.has(devicePlatform);
}

/**
 * False only when devicectl names a tunnel state it documents as unreachable.
 * A missing or unrecognized state passes; see {@link UNREACHABLE_TUNNEL_STATES}.
 */
function isReachable(connection: Record<string, unknown> | null): boolean {
  const tunnelState = asString(connection?.tunnelState)?.toLowerCase();
  return !tunnelState || !UNREACHABLE_TUNNEL_STATES.has(tunnelState);
}

/**
 * Best available human-readable name for a device record, falling back to the
 * UDID so a device is never surfaced nameless.
 */
function deviceDisplayName(
  deviceProperties: Record<string, unknown> | null,
  hardware: Record<string, unknown> | null,
  udid: string,
): string {
  return (
    asString(deviceProperties?.name) ??
    asString(hardware?.marketingName) ??
    asString(hardware?.deviceType) ??
    udid
  );
}

/**
 * Classify one devicectl device record.
 *
 * The order matters: the two *understood* rejections — a non-iOS platform and a
 * documented-unreachable tunnel state — are checked first, so everything that
 * survives them is a record devicectl says is a reachable iOS CoreDevice. Those
 * are physical hardware by definition, so failing to read a physical UDID out of
 * one is schema drift rather than a device we meant to skip, and it must make the
 * whole listing non-authoritative.
 *
 * The UDID is validated with the canonical {@link isIosPhysicalUdid} predicate
 * rather than trusted, so a simulator-shaped entry or a renamed field can never
 * be surfaced as a physical iOS device.
 */
function classifyDeviceEntry(entry: unknown): DeviceEntryOutcome {
  const record = asRecord(entry);
  if (!record) {
    // A non-record entry inside a recognized envelope is drift, not a device.
    return MALFORMED;
  }

  const hardware = asRecord(record.hardwareProperties);
  if (!isIosPlatform(hardware) || !isReachable(asRecord(record.connectionProperties))) {
    return FILTERED;
  }

  const udid = asString(hardware?.udid) ?? asString(record.identifier);
  if (!udid || !isIosPhysicalUdid(udid)) {
    return MALFORMED;
  }

  const deviceProperties = asRecord(record.deviceProperties);
  const osVersion = asString(deviceProperties?.osVersionNumber);
  const formFactor = inferIosFormFactor(asString(hardware?.productType));

  return {
    kind: "device",
    device: {
      name: deviceDisplayName(deviceProperties, hardware, udid),
      platform: "ios",
      deviceId: udid,
      ...(osVersion ? { iosVersion: osVersion, osVersion } : {}),
      ...(formFactor ? { formFactor } : {}),
    },
  };
}

/**
 * Parse a `devicectl list devices --json-output` payload into the reachable
 * physical iOS devices it reports, sorted by UDID to match
 * `SimCtlClient.getBootedSimulatorsChecked`'s stable ordering.
 *
 * `complete` separates a *recognized* listing (authoritative — an empty one means
 * "nothing is plugged in") from one this parser could not fully read. That covers
 * both halves of the payload: an envelope it does not understand — a failed
 * `info.outcome`, a missing/non-array `devices`, or a future rename — and an
 * individual entry devicectl calls a reachable iOS device but which yields no
 * physical UDID. Reporting either as authoritative is what would let the
 * disconnect monitor drop a still-connected iPhone.
 *
 * Exported separately from the client so the payload shape can be pinned by
 * fast unit tests with no host tooling involved.
 */
export function parseDevicectlDeviceList(data: unknown): PhysicalIosDeviceDiscovery {
  const entries = extractDeviceEntries(data);
  if (!entries) {
    return { devices: [], complete: false };
  }
  const outcomes = entries.map(classifyDeviceEntry);
  const devices = outcomes
    .filter((outcome) => outcome.kind === "device")
    .map((outcome) => outcome.device);
  devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  // The devices that did resolve are still reported: the caller needs both the
  // iPhone it found and the signal that something in the payload was unreadable.
  return { devices, complete: !outcomes.some((outcome) => outcome.kind === "malformed") };
}

/**
 * Union two device listings by UDID, preferring the first list's record for a
 * device both report, and keeping the UDID ordering `parseDevicectlDeviceList`
 * establishes.
 */
function mergeById(preferred: BootedDevice[], fallback: BootedDevice[]): BootedDevice[] {
  const seen = new Set(preferred.map((device) => device.deviceId));
  const merged = [...preferred, ...fallback.filter((device) => !seen.has(device.deviceId))];
  merged.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  return merged;
}

/**
 * How long a devicectl listing is reused before re-shelling out.
 *
 * `getBootedDevices("ios")` is a hot path — the app resources and the daemon's
 * device sweep both call it — while `devicectl list devices` costs on the order
 * of a second. The window is short enough that a freshly-plugged device shows up
 * within one sweep, and long enough that a burst of resource reads spawns one
 * process rather than one per read.
 */
const DEVICE_LIST_CACHE_TTL_MS = 3_000;

/**
 * Ceiling on one `devicectl list devices` invocation. Unbounded, a stalled
 * devicectl would hang every caller awaiting iOS discovery — including
 * simulator-only app-resource reads — and the shared in-flight promise would
 * wedge each later sweep behind it.
 */
const DEVICE_LIST_TIMEOUT_MS = 15_000;

/**
 * How long a failing sweep keeps reporting the devices the last good sweep
 * found.
 *
 * Without this, a single devicectl blip makes a connected iPhone vanish from
 * discovery, and the daemon's disconnect monitor starts counting misses against
 * a device that never went anywhere. Retaining last-known devices keeps the
 * iPhone in the discovered list while `complete: false` still tells callers the
 * sweep was not authoritative. The window is bounded so a permanently broken
 * devicectl eventually stops asserting hardware that may well be unplugged.
 */
const LAST_GOOD_RETENTION_MS = 60_000;

interface DevicectlDeviceListerDependencies {
  platform: () => NodeJS.Platform;
  timer: Pick<Timer, "now">;
  observationSequence: DiscoveryObservationSequence;
  execute: (file: string, args: string[], options: HostCommandOptions) => Promise<ExecResult>;
  readFile: (path: string) => Promise<string>;
  mkdtemp: (prefix: string) => Promise<string>;
  rm: (path: string) => Promise<void>;
  tmpdir: () => string;
  logger: Pick<Logger, "debug" | "warn">;
}

const defaultDependencies: DevicectlDeviceListerDependencies = {
  platform: () => process.platform,
  execute: (file, args, options) =>
    new DefaultHostCommandExecutor().executeCommand(file, args, options),
  readFile: async (path) => fs.readFile(path, "utf-8"),
  mkdtemp: async (prefix) => fs.mkdtemp(prefix),
  rm: async (path) => fs.rm(path, { recursive: true, force: true }),
  tmpdir,
  logger,
  timer: defaultTimer,
  observationSequence: defaultDiscoveryObservationSequence,
};

/**
 * Lists connected physical iOS devices via `xcrun devicectl list devices`.
 *
 * macOS-only and entirely best-effort: every failure path (non-darwin host,
 * missing Xcode, devicectl error, unreadable JSON) logs and returns an empty
 * list. Physical-device discovery is additive to the simulator list, so a
 * failure here must degrade iOS discovery to "simulators only" rather than
 * failing the whole sweep.
 */
export class DevicectlDeviceLister implements IosPhysicalDeviceLister {
  private readonly deps: DevicectlDeviceListerDependencies;
  private cache: {
    discovery: PhysicalIosDeviceDiscovery;
    observedAt: number;
    expiresAt: number;
  } | null = null;
  private lastGood: { devices: BootedDevice[]; observedAt: number; staleAfter: number } | null =
    null;
  private inFlight: Promise<PhysicalIosDeviceDiscovery> | null = null;

  constructor(dependencies: Partial<DevicectlDeviceListerDependencies> = {}) {
    this.deps = { ...defaultDependencies, ...dependencies };
  }

  async listConnectedDevices(): Promise<PhysicalIosDeviceDiscovery> {
    if (this.deps.platform() !== "darwin") {
      return { devices: [], complete: true };
    }
    const now = this.deps.timer.now();
    // A backward wall-clock adjustment makes cached freshness unknowable.
    // Re-list immediately rather than retaining a stale physical-device name.
    if (this.cache && now >= this.cache.observedAt && now < this.cache.expiresAt) {
      return this.cache.discovery;
    }
    // Concurrent sweeps share one devicectl process rather than racing two.
    this.inFlight ??= this.runListing().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runListing(): Promise<PhysicalIosDeviceDiscovery> {
    let tempDir: string | null = null;
    try {
      tempDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-devicectl-devices-"));
      const jsonPath = join(tempDir, "devices.json");
      await this.deps.execute(
        "xcrun",
        ["devicectl", "list", "devices", "--json-output", jsonPath, "--quiet"],
        // Deliberately NOT wired to the ambient abort signal: this listing is
        // shared across concurrent callers, so honoring one caller's
        // cancellation would cancel the process out from under the others. The
        // timeout is what bounds it.
        { timeoutMs: DEVICE_LIST_TIMEOUT_MS },
      );
      const raw = await this.deps.readFile(jsonPath);
      return this.remember(parseDevicectlDeviceList(JSON.parse(raw) as unknown));
    } catch (error) {
      // A host without Xcode 15+, without paired hardware, or with a devicectl
      // that failed still has working simulator discovery; degrade to
      // "no physical devices" rather than breaking the iOS sweep.
      this.deps.logger.debug(
        `[DevicectlDeviceLister] physical iOS device discovery unavailable: ${errorMessage(error)}`,
      );
      // Cache the failure too: a host with no Xcode must not pay for a failing
      // process spawn on every sweep.
      return this.remember({ devices: [], complete: false });
    } finally {
      if (tempDir) {
        try {
          await this.deps.rm(tempDir);
        } catch (cleanupError) {
          this.deps.logger.warn(
            `[DevicectlDeviceLister] Failed to remove temporary device listing directory ${tempDir}: ${errorMessage(cleanupError)}`,
          );
        }
      }
    }
  }

  private remember(discovery: PhysicalIosDeviceDiscovery): PhysicalIosDeviceDiscovery {
    const now = this.deps.timer.now();
    const observedAt = this.deps.observationSequence.next();
    // A cache hit or retained result must retain when it was observed, rather
    // than appear newer merely because a later caller read it.
    const stamped = {
      ...discovery,
      devices: discovery.devices.map((device) => ({
        ...device,
        observedAt: device.observedAt ?? observedAt,
      })),
    };
    let resolved: PhysicalIosDeviceDiscovery;
    if (stamped.complete) {
      resolved = this.recordLastGood(stamped, now);
    } else {
      // A partial sweep and the retained listing are both incomplete views of
      // the same hardware, so neither may evict the other's device: union
      // them. When the sweep failed outright its half is empty and this
      // degrades to pure retention.
      const fresh = new Set(stamped.devices.map((device) => device.deviceId));
      const retained = this.retainedDevices(now);
      // Only the replayed half is stale. A device this sweep parsed stays fresh
      // even though a sibling record was unreadable.
      const retainedDeviceIds = retained
        .map((device) => device.deviceId)
        .filter((id) => !fresh.has(id));
      resolved = {
        devices: mergeById(stamped.devices, retained),
        complete: false,
        // Omitted when empty so a pure-failure sweep keeps its original shape.
        ...(retainedDeviceIds.length > 0 ? { retainedDeviceIds: new Set(retainedDeviceIds) } : {}),
      };
    }
    this.cache = {
      discovery: resolved,
      observedAt: now,
      expiresAt: now + DEVICE_LIST_CACHE_TTL_MS,
    };
    return resolved;
  }

  private recordLastGood(
    discovery: PhysicalIosDeviceDiscovery,
    now: number,
  ): PhysicalIosDeviceDiscovery {
    this.lastGood = {
      devices: discovery.devices,
      observedAt: now,
      staleAfter: now + LAST_GOOD_RETENTION_MS,
    };
    return discovery;
  }

  /** Devices the last good sweep found, while still inside the retention window. */
  private retainedDevices(now: number): BootedDevice[] {
    if (!this.lastGood || now >= this.lastGood.staleAfter) {
      this.lastGood = null;
      return [];
    }
    if (now < this.lastGood.observedAt) {
      this.lastGood.observedAt = now;
      this.lastGood.staleAfter = now + LAST_GOOD_RETENTION_MS;
    }
    return this.lastGood.devices;
  }
}
