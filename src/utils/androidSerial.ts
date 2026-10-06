import { ActionableError, type BootedDevice } from "../models";
import type { AdbClientFactory } from "./android-cmdline-tools/AdbClientFactory";
import { logger } from "./logger";
import { errorMessage } from "./describeUnknownError";
import { consolePortFromSerial } from "./android-cmdline-tools/EmulatorConsoleClient";

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

/** Identity cache and aliases belong to one pool, and retire with its entry. */
export class AndroidTransportAliases implements AndroidTransportRouting {
  private readonly identities = new Map<string, Promise<TransportIdentity | undefined>>();
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
    const adb = this.adbFactory.create(device);
    const property = async (name: string) =>
      (
        await adb.execute(["shell", "getprop", name], { noRetry: true, timeoutMs: 2000 })
      ).stdout.trim();
    try {
      const serial = await property("ro.serialno");
      const qemu = await property("ro.kernel.qemu");
      if (qemu === "1") {
        const avdName = await property("ro.boot.qemu.avd_name");
        const consoleSerial =
          consolePortFromSerial(serial) !== null ? serial : loopbackConsoleSerial(device.deviceId);
        // Never merge two emulator instances merely because they share an AVD name.
        return avdName && consoleSerial ? { key: consoleSerial, avdName } : undefined;
      }
      return serial && serial !== "unknown" ? { key: serial } : undefined;
    } catch (error) {
      logger.warn(
        `Android transport identity unavailable for ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  /** Cold transport probes run outside the pool lock; durable serials need no probes. */
  async prepare(devices: readonly BootedDevice[]): Promise<ReadonlyMap<string, TransportIdentity>> {
    const evidence = new Map<string, TransportIdentity>();
    await Promise.all(
      devices.map(async (device) => {
        if (device.platform !== "android" || !isAndroidTransportAddressSerial(device.deviceId)) {
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
    let pending = this.identities.get(device.deviceId);
    if (!pending) {
      pending = this.readIdentity(device);
      this.identities.set(device.deviceId, pending);
    }
    let identity = await pending;
    if (this.contradictsEmulatorPeer(identity, devices)) {
      // A different resolved AVD on this console slot proves the cached incarnation ended.
      pending = this.readIdentity(device);
      this.identities.set(device.deviceId, pending);
      identity = await pending;
    }
    if (!identity || this.contradictsEmulatorPeer(identity, devices)) {
      if (this.identities.get(device.deviceId) === pending) {
        this.identities.delete(device.deviceId);
      }
      throw new ActionableError(
        `Could not identify Android transport '${device.deviceId}'. Check its adb connection and retry discovery.`,
      );
    }
    return identity;
  }

  /** Commit a discovery snapshot against current pool membership under its mutex. */
  fold(
    devices: readonly BootedDevice[],
    evidence: ReadonlyMap<string, TransportIdentity>,
    pooledIds: ReadonlySet<string>,
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
    const result = devices.filter((device) => device.platform !== "android");
    for (const [key, rows] of byIdentity) {
      result.push(this.foldGroup(key, rows, evidence, pooledIds));
    }
    return result;
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
  ): BootedDevice {
    const previous = this.groups.get(key);
    const canonical = this.canonicalSerial(rows, previous, pooledIds);
    const representative = rows.find((row) => row.deviceId === canonical) ?? rows[0];
    const avdName = rows.map((row) => evidence.get(row.deviceId)?.avdName).find(Boolean);
    const live = rows.map((row) => row.deviceId);
    const serials = new Set([...(previous?.serials ?? []), ...live]);
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
    const group = [...this.groups.values()].find((entry) => entry.canonical === deviceId);
    return group ? [...group.serials].filter((serial) => serial !== deviceId) : [];
  }

  avdName(deviceId: string): string | undefined {
    return [...this.groups.values()].find((entry) => entry.canonical === deviceId)?.avdName;
  }

  retire(deviceId: string): void {
    for (const [key, group] of this.groups) {
      if (group.canonical !== deviceId) {
        continue;
      }
      group.serials.forEach((serial) => this.identities.delete(serial));
      this.groups.delete(key);
    }
    this.routes.delete(deviceId);
  }
}
