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

interface TransportIdentity {
  key: string;
  avdName?: string;
}

interface TransportGroup {
  canonical: string;
  name: string;
  serials: Set<string>;
  avdName?: string;
}

/** Only a loopback adb port identifies a local emulator's console slot. */
function loopbackConsoleSerial(serial: string): string | undefined {
  const match = /^(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)$/.exec(serial);
  const port = match ? Number(match[1]) - 1 : 0;
  return port >= 5554 && port % 2 === 0 && port <= 65534 ? `emulator-${port}` : undefined;
}

/** Alias groups belong to one pool; transport identity is reverified per observation. */
export class AndroidTransportAliases implements AndroidTransportRouting {
  private readonly groups = new Map<string, TransportGroup>();
  private readonly routes = new Map<string, string>();

  constructor(private readonly adbFactory: AdbClientFactory) {}

  needsNormalization(devices: readonly BootedDevice[]): boolean {
    return (
      this.groups.size > 0 ||
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
      return bootId ? { key: `physical:${JSON.stringify([serial, bootId])}` } : undefined;
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
    // Endpoint strings can be reused without an intervening discovery (DHCP,
    // adb reconnect, or reboot). Never reuse identity evidence across snapshots.
    const identity = await this.readIdentity(device);
    if (!identity || this.contradictsEmulatorPeer(identity, devices)) {
      logger.warn(
        `Android transport '${device.deviceId}' could not be identified; leaving it unaliased.`,
      );
      return undefined;
    }
    return identity;
  }

  /** Commit a discovery snapshot against current pool membership under its mutex. */
  fold(
    devices: readonly BootedDevice[],
    evidence: ReadonlyMap<string, TransportIdentity>,
    pooledIds: ReadonlySet<string>,
    completeSnapshot = true,
  ): BootedDevice[] {
    const byIdentity = new Map<string, BootedDevice[]>();
    for (const device of devices) {
      if (device.platform !== "android") {
        continue;
      }
      const key = evidence.get(device.deviceId)?.key ?? device.deviceId;
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
    });
    this.routes.set(canonical, live.includes(canonical) ? canonical : live[0]);
    return { ...representative, deviceId: canonical, name };
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
      this.groups.delete(key);
      retired = true;
    }
    this.routes.delete(deviceId);
    return retired;
  }
}
