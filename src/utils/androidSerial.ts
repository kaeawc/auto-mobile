import { type BootedDevice } from "../models";
import type { AdbClientFactory } from "./android-cmdline-tools/AdbClientFactory";
import { logger } from "./logger";
import { errorMessage } from "./describeUnknownError";

/**
 * adb reserves the `emulator-<port>` serial shape for locally-running Android
 * emulators; transport addresses need identity evidence to classify. Several call
 * sites had grown their own copy of this predicate, so keep exactly one
 * spelling here (issue #6850 review).
 */
const ANDROID_EMULATOR_SERIAL_PATTERN = /^emulator-\d+$/;

/** ADB transport addresses are connection endpoints rather than durable ids. */
const ANDROID_TRANSPORT_ADDRESS_SERIAL_PATTERN =
  /^(?:[A-Za-z0-9.-]+|\[[^\]]+\]):\d+$|\._adb-tls-connect\._tcp|\._adb\._tcp/;

/** True when `deviceId` is an adb emulator serial (e.g. `emulator-5554`). */
export function isAndroidEmulatorSerial(deviceId: string): boolean {
  return ANDROID_EMULATOR_SERIAL_PATTERN.test(deviceId);
}

/** True when `deviceId` is an ADB TCP or mDNS transport address. */
export function isAndroidTransportAddressSerial(deviceId: string): boolean {
  return ANDROID_TRANSPORT_ADDRESS_SERIAL_PATTERN.test(deviceId);
}

/** Explicit per-pool routing seam. Clients resolve it on every dispatch. */
export interface AndroidTransportRouting {
  resolveTransport(deviceId: string): string;
}

// Connection metadata travels with discovery rows through enrichment spreads, but
// is absent from BootedDevice's identity contract and JSON/tool output.
const adbTransportId = Symbol("adb transport id");
type AndroidTransportRow = BootedDevice & { [adbTransportId]?: string };

export function withAndroidTransportId<T extends object>(device: T, transportId?: string): T {
  return transportId ? { ...device, [adbTransportId]: transportId } : device;
}

/** Preserve private connection metadata when a state row becomes a discovery row. */
export function copyAndroidTransportId<T extends object>(source: object, target: T): T {
  return withAndroidTransportId(target, (source as AndroidTransportRow)[adbTransportId]);
}

function transportIdFor(device: BootedDevice): string | undefined {
  return (device as AndroidTransportRow)[adbTransportId];
}

interface TransportIdentity {
  key: string;
  avdName?: string;
  physicalSerial?: string;
}

interface TransportGroup {
  canonical: string;
  name: string;
  serials: Set<string>;
  avdName?: string;
  physicalSerial?: string;
  transportIds: Map<string, string | undefined>;
}

interface ConnectionEvidence {
  transportId?: string;
  identity: Promise<TransportIdentity | undefined>;
  provenIdentity?: TransportIdentity;
}

/** Only a loopback adb port identifies a local emulator's console slot. */
function loopbackConsoleSerial(serial: string): string | undefined {
  const match = /^(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)$/.exec(serial);
  const port = match ? Number(match[1]) - 1 : 0;
  return port >= 5554 && port % 2 === 0 && port <= 65534 ? `emulator-${port}` : undefined;
}

/** Alias groups and connection evidence belong to one pool. Presence always comes from rows. */
export class AndroidTransportAliases implements AndroidTransportRouting {
  private readonly groups = new Map<string, TransportGroup>();
  private readonly routes = new Map<string, string>();
  private readonly connections = new Map<string, ConnectionEvidence>();
  private readonly unproven = new Set<string>();

  constructor(private readonly adbFactory: AdbClientFactory) {}

  needsNormalization(devices: readonly BootedDevice[]): boolean {
    return (
      this.groups.size > 0 ||
      this.connections.size > 0 ||
      devices.some(
        (device) =>
          device.platform === "android" && isAndroidTransportAddressSerial(device.deviceId),
      )
    );
  }

  private async readIdentity(device: BootedDevice): Promise<TransportIdentity | undefined> {
    try {
      const adb = this.adbFactory.create(device);
      const property = async (name: string) =>
        (
          await adb.execute(["shell", "getprop", name], { noRetry: true, timeoutMs: 2000 })
        ).stdout.trim();
      const serial = await property("ro.serialno");
      const qemu = await property("ro.kernel.qemu");
      if (qemu === "1") {
        const avdName = await property("ro.boot.qemu.avd_name");
        const consoleSerial = isAndroidEmulatorSerial(device.deviceId)
          ? device.deviceId
          : loopbackConsoleSerial(device.deviceId);
        // Never merge two emulator instances merely because they share an AVD name.
        return avdName && consoleSerial ? { key: consoleSerial, avdName } : undefined;
      }
      // Generic factory serials cannot prove that two endpoints reach one handset.
      if (!serial || ["unknown", "0123456789abcdef"].includes(serial.toLowerCase())) {
        return undefined;
      }
      const bootId = (
        await adb.execute(["shell", "cat", "/proc/sys/kernel/random/boot_id"], {
          noRetry: true,
          timeoutMs: 2000,
        })
      ).stdout.trim();
      return bootId
        ? { key: `physical:${JSON.stringify([serial, bootId])}`, physicalSerial: serial }
        : undefined;
    } catch (error) {
      logger.warn(
        `Android transport identity unavailable for ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  /** Probes run outside the pool lock. Physical peers need the same serial AND boot id. */
  async prepare(devices: readonly BootedDevice[]): Promise<ReadonlyMap<string, TransportIdentity>> {
    const evidence = new Map<string, TransportIdentity>();
    if (!this.needsNormalization(devices)) {
      return evidence;
    }
    await Promise.all(
      devices.map(async (device) => {
        if (device.platform !== "android" || isAndroidEmulatorSerial(device.deviceId)) {
          return;
        }
        const identity = await this.prepareIdentity(device, devices);
        if (identity) {
          evidence.set(device.deviceId, identity);
        }
      }),
    );
    return evidence;
  }

  private contradictsEmulatorPeer(
    identity: TransportIdentity | undefined,
    devices: readonly BootedDevice[],
  ): boolean {
    if (!identity?.avdName) {
      return false;
    }
    const peer = devices.find(
      (device) => device.deviceId === identity.key && isAndroidEmulatorSerial(device.deviceId),
    );
    return (
      peer !== undefined &&
      peer.name !== peer.deviceId &&
      peer.name !== `Unknown (${peer.deviceId})` &&
      peer.name !== identity.avdName
    );
  }

  private async prepareIdentity(
    device: BootedDevice,
    devices: readonly BootedDevice[],
  ): Promise<TransportIdentity | undefined> {
    const transportId = transportIdFor(device);
    let connection = this.connections.get(device.deviceId);
    if (!connection || connection.transportId !== transportId) {
      connection = { transportId, identity: this.readIdentity(device) };
      this.connections.set(device.deviceId, connection);
    }
    const identity = await connection.identity;
    // Share an in-flight probe, but retry missing evidence on the next refresh.
    // An older failure must not evict evidence for a replacement transport_id.
    if (!identity && this.connections.get(device.deviceId) === connection) {
      this.connections.delete(device.deviceId);
    }
    if (!identity || this.contradictsEmulatorPeer(identity, devices)) {
      logger.warn(
        `Android transport '${device.deviceId}' could not be identified; leaving it unaliased.`,
      );
      return undefined;
    }
    connection.provenIdentity = identity;
    return identity;
  }

  /** Commit a discovery snapshot against current pool membership under its mutex. */
  fold(
    devices: readonly BootedDevice[],
    evidence: ReadonlyMap<string, TransportIdentity>,
    pooledIds: ReadonlySet<string>,
    completeSnapshot = true,
  ): BootedDevice[] {
    const claimedSerials = this.claimedPhysicalSerials(evidence);
    const blockedKeys = this.unprovenPooledPeerKeys(evidence, pooledIds);
    if (completeSnapshot) {
      this.pruneConnectionEvidence(devices);
    }
    const byIdentity = new Map<string, BootedDevice[]>();
    for (const device of devices) {
      if (device.platform !== "android") {
        continue;
      }
      const key = evidence.get(device.deviceId)?.key ?? device.deviceId;
      this.recordUnprovenTransport(
        device.deviceId,
        evidence.get(device.deviceId),
        claimedSerials,
        blockedKeys,
      );
      const rows = byIdentity.get(key) ?? [];
      rows.push(device);
      byIdentity.set(key, rows);
    }
    if (completeSnapshot) {
      this.pruneDisconnectedTransports(byIdentity, pooledIds);
    }
    const result = devices.filter((device) => device.platform !== "android");
    for (const [key, rows] of byIdentity) {
      result.push(this.foldGroup(key, rows, evidence, pooledIds, completeSnapshot));
    }
    return result;
  }

  private recordUnprovenTransport(
    serial: string,
    identity: TransportIdentity | undefined,
    claimedSerials: ReadonlySet<string>,
    blockedKeys: ReadonlySet<string>,
  ): void {
    const unproven = identity
      ? blockedKeys.has(identity.key)
      : isAndroidTransportAddressSerial(serial) || claimedSerials.has(serial);
    if (unproven) {
      this.unproven.add(serial);
    } else {
      this.unproven.delete(serial);
    }
  }

  private unprovenPooledPeerKeys(
    evidence: ReadonlyMap<string, TransportIdentity>,
    pooledIds: ReadonlySet<string>,
  ): Set<string> {
    // A lone USB row can have been acquired before any peer was proven. Keep
    // that reservation without inferring an alias from serial-only evidence.
    return new Set(
      [...evidence.values()]
        .filter(
          (identity) =>
            identity.physicalSerial !== undefined &&
            pooledIds.has(identity.physicalSerial) &&
            !evidence.has(identity.physicalSerial) &&
            this.groups.get(identity.key)?.canonical !== identity.physicalSerial,
        )
        .map((identity) => identity.key),
    );
  }

  private claimedPhysicalSerials(evidence: ReadonlyMap<string, TransportIdentity>): Set<string> {
    // Read before pruning: cached proof still claims a serial even when a peer is
    // absent from this snapshot. Missing evidence must not create another owner.
    const identities = [
      ...evidence.values(),
      ...this.groups.values(),
      ...[...this.connections.values()].map((connection) => connection.provenIdentity),
    ];
    return new Set(
      identities.flatMap((identity) => (identity?.physicalSerial ? [identity.physicalSerial] : [])),
    );
  }

  private pruneConnectionEvidence(devices: readonly BootedDevice[]): void {
    const present = new Set(
      devices.filter((row) => row.platform === "android").map((row) => row.deviceId),
    );
    for (const serial of this.connections.keys()) {
      if (!present.has(serial)) {
        this.connections.delete(serial);
        this.unproven.delete(serial);
      }
    }
  }

  private pruneDisconnectedTransports(
    byIdentity: ReadonlyMap<string, readonly BootedDevice[]>,
    pooledIds: ReadonlySet<string>,
  ): void {
    for (const [key, group] of this.groups) {
      group.serials = new Set((byIdentity.get(key) ?? []).map((row) => row.deviceId));
      if (group.serials.size === 0) {
        this.routes.delete(group.canonical);
        if (!pooledIds.has(group.canonical)) {
          this.groups.delete(key);
        }
      }
    }
  }

  private canonicalSerial(
    rows: BootedDevice[],
    previous: TransportGroup | undefined,
    pooledIds: ReadonlySet<string>,
  ): string {
    if (previous && pooledIds.has(previous.canonical)) {
      return previous.canonical;
    }
    return (
      rows.find((row) => pooledIds.has(row.deviceId))?.deviceId ??
      rows.find((row) => !isAndroidTransportAddressSerial(row.deviceId))?.deviceId ??
      rows[0].deviceId
    );
  }

  private foldGroup(
    key: string,
    rows: BootedDevice[],
    evidence: ReadonlyMap<string, TransportIdentity>,
    pooledIds: ReadonlySet<string>,
    completeSnapshot: boolean,
  ): BootedDevice {
    const previous = this.groups.get(key);
    const canonical = this.canonicalSerial(rows, previous, pooledIds);
    const representative = rows.find((row) => row.deviceId === canonical) ?? rows[0];
    const avdName = rows.map((row) => evidence.get(row.deviceId)?.avdName).find(Boolean);
    const live = rows.map((row) => row.deviceId);
    const serials = new Set([...(completeSnapshot ? [] : (previous?.serials ?? [])), ...live]);
    const name =
      avdName ??
      (representative.deviceId === canonical ? representative.name : previous?.name) ??
      representative.name;
    this.groups.set(key, {
      canonical,
      name,
      serials,
      avdName: avdName ?? previous?.avdName,
      physicalSerial: rows.map((row) => evidence.get(row.deviceId)?.physicalSerial).find(Boolean),
      transportIds: this.connectionIdsFor(rows, previous, completeSnapshot),
    });
    this.routes.set(canonical, live.includes(canonical) ? canonical : live[0]);
    return { ...representative, deviceId: canonical, name };
  }

  private connectionIdsFor(
    rows: readonly BootedDevice[],
    previous: TransportGroup | undefined,
    completeSnapshot: boolean,
  ): Map<string, string | undefined> {
    const ids = new Map(completeSnapshot ? undefined : previous?.transportIds);
    for (const row of rows) {
      ids.set(row.deviceId, transportIdFor(row));
    }
    return ids;
  }

  /** Read-only presence mapping: never probe, prune, or update routing on a monitor tick. */
  mapDiscovery(devices: readonly BootedDevice[], updateRouting = false): BootedDevice[] {
    const mapped = new Map<string, BootedDevice>();
    for (const device of devices) {
      const group =
        device.platform === "android"
          ? [...this.groups.values()].find(
              (entry) =>
                entry.serials.has(device.deviceId) &&
                entry.transportIds.get(device.deviceId) === transportIdFor(device),
            )
          : undefined;
      const row = group ? { ...device, deviceId: group.canonical, name: group.name } : device;
      mapped.set(`${row.platform}:${row.deviceId}`, row);
    }
    if (updateRouting) {
      // A proven live row may change the dispatch route without changing group
      // membership. This also covers selection's presence sweep after USB removal.
      for (const group of this.groups.values()) {
        const live = devices.filter(
          (row) =>
            row.platform === "android" &&
            group.serials.has(row.deviceId) &&
            group.transportIds.get(row.deviceId) === transportIdFor(row),
        );
        if (live.length > 0) {
          this.routes.set(
            group.canonical,
            live.find((row) => row.deviceId === group.canonical)?.deviceId ?? live[0].deviceId,
          );
        }
      }
    }
    return [...mapped.values()];
  }

  isAssignable(device: BootedDevice): boolean {
    return (
      device.platform !== "android" ||
      (!this.unproven.has(device.deviceId) &&
        (!isAndroidTransportAddressSerial(device.deviceId) ||
          [...this.groups.values()].some(
            (group) =>
              group.canonical === device.deviceId &&
              [...group.serials].some((serial) => !this.unproven.has(serial)),
          )))
    );
  }

  resolveTransport(deviceId: string): string {
    return this.routes.get(deviceId) ?? deviceId;
  }

  aliases(deviceId: string): string[] {
    return [...this.groups.values()]
      .filter((entry) => entry.canonical === deviceId)
      .flatMap((group) => [...group.serials].filter((serial) => serial !== deviceId));
  }

  avdName(deviceId: string): string | undefined {
    return [...this.groups.values()].find((entry) => entry.canonical === deviceId)?.avdName;
  }

  retire(deviceId: string): boolean {
    let retired = false;
    for (const [key, group] of this.groups) {
      if (group.canonical !== deviceId) {
        continue;
      }
      for (const serial of group.serials) {
        this.connections.delete(serial);
        this.unproven.delete(serial);
      }
      this.groups.delete(key);
      retired = true;
    }
    this.routes.delete(deviceId);
    return retired;
  }
}
