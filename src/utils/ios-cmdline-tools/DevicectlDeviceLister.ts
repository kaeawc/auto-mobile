import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ExecResult } from "../../models";
import type { BootedDevice } from "../../models/DeviceInfo";
import { errorMessage } from "../describeUnknownError";
import { DefaultHostCommandExecutor } from "../HostCommandExecutor";
import { logger, type Logger } from "../logger";
import { defaultTimer, type Timer } from "../SystemTimer";
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
  listConnectedDevices(): Promise<BootedDevice[]>;
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
function extractDeviceEntries(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  const root = asRecord(data);
  if (!root) {
    return [];
  }
  const result = asRecord(root.result);
  const devices = result?.devices ?? root.devices;
  return Array.isArray(devices) ? devices : [];
}

/**
 * The physical-device UDID a devicectl record identifies, or null when the
 * record is not a reachable physical iOS device.
 *
 * The UDID is validated with the canonical {@link isIosPhysicalUdid} predicate
 * rather than trusted, so a simulator entry, a paired-Watch record, or a renamed
 * field can never be surfaced as a physical iOS device.
 */
function reachablePhysicalUdid(
  hardware: Record<string, unknown> | null,
  connection: Record<string, unknown> | null,
  identifier: unknown,
): string | null {
  const udid = asString(hardware?.udid) ?? asString(identifier);
  if (!udid || !isIosPhysicalUdid(udid)) {
    return null;
  }
  const tunnelState = asString(connection?.tunnelState)?.toLowerCase();
  return tunnelState && UNREACHABLE_TUNNEL_STATES.has(tunnelState) ? null : udid;
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
 * Convert one devicectl device record into a `BootedDevice`, or null when the
 * record is not a reachable physical iOS device.
 */
function toBootedDevice(entry: unknown): BootedDevice | null {
  const record = asRecord(entry);
  if (!record) {
    return null;
  }

  const hardware = asRecord(record.hardwareProperties);
  const udid = reachablePhysicalUdid(
    hardware,
    asRecord(record.connectionProperties),
    record.identifier,
  );
  if (!udid) {
    return null;
  }

  const deviceProperties = asRecord(record.deviceProperties);
  const osVersion = asString(deviceProperties?.osVersionNumber);
  const formFactor = inferIosFormFactor(asString(hardware?.productType));

  return {
    name: deviceDisplayName(deviceProperties, hardware, udid),
    platform: "ios",
    deviceId: udid,
    ...(osVersion ? { iosVersion: osVersion, osVersion } : {}),
    ...(formFactor ? { formFactor } : {}),
  };
}

/**
 * Parse a `devicectl list devices --json-output` payload into the reachable
 * physical iOS devices it reports, sorted by UDID to match
 * `SimCtlClient.getBootedSimulatorsChecked`'s stable ordering.
 *
 * Exported separately from the client so the payload shape can be pinned by
 * fast unit tests with no host tooling involved.
 */
export function parseDevicectlDeviceList(data: unknown): BootedDevice[] {
  const devices = extractDeviceEntries(data)
    .map(toBootedDevice)
    .filter((device): device is BootedDevice => device !== null);
  devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  return devices;
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

interface DevicectlDeviceListerDependencies {
  platform: () => NodeJS.Platform;
  timer: Pick<Timer, "now">;
  execute: (file: string, args: string[]) => Promise<ExecResult>;
  readFile: (path: string) => Promise<string>;
  mkdtemp: (prefix: string) => Promise<string>;
  rm: (path: string) => Promise<void>;
  tmpdir: () => string;
  logger: Pick<Logger, "debug" | "warn">;
}

const defaultDependencies: DevicectlDeviceListerDependencies = {
  platform: () => process.platform,
  execute: (file, args) => new DefaultHostCommandExecutor().executeCommand(file, args),
  readFile: async (path) => fs.readFile(path, "utf-8"),
  mkdtemp: async (prefix) => fs.mkdtemp(prefix),
  rm: async (path) => fs.rm(path, { recursive: true, force: true }),
  tmpdir,
  logger,
  timer: defaultTimer,
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
  private cache: { devices: BootedDevice[]; expiresAt: number } | null = null;
  private inFlight: Promise<BootedDevice[]> | null = null;

  constructor(dependencies: Partial<DevicectlDeviceListerDependencies> = {}) {
    this.deps = { ...defaultDependencies, ...dependencies };
  }

  async listConnectedDevices(): Promise<BootedDevice[]> {
    if (this.deps.platform() !== "darwin") {
      return [];
    }
    if (this.cache && this.deps.timer.now() < this.cache.expiresAt) {
      return this.cache.devices;
    }
    // Concurrent sweeps share one devicectl process rather than racing two.
    this.inFlight ??= this.runListing().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runListing(): Promise<BootedDevice[]> {
    let tempDir: string | null = null;
    try {
      tempDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-devicectl-devices-"));
      const jsonPath = join(tempDir, "devices.json");
      await this.deps.execute("xcrun", [
        "devicectl",
        "list",
        "devices",
        "--json-output",
        jsonPath,
        "--quiet",
      ]);
      const raw = await this.deps.readFile(jsonPath);
      return this.remember(parseDevicectlDeviceList(JSON.parse(raw) as unknown));
    } catch (error) {
      // A host without Xcode 15+, without paired hardware, or with a devicectl
      // that failed still has working simulator discovery; degrade to
      // "no physical devices" rather than breaking the iOS sweep.
      this.deps.logger.debug(
        `[DevicectlDeviceLister] physical iOS device discovery unavailable: ${errorMessage(error)}`,
      );
      // Cache the empty result too: a host with no Xcode must not pay for a
      // failing process spawn on every sweep.
      return this.remember([]);
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

  private remember(devices: BootedDevice[]): BootedDevice[] {
    this.cache = { devices, expiresAt: this.deps.timer.now() + DEVICE_LIST_CACHE_TTL_MS };
    return devices;
  }
}
