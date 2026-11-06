import type {
  AdbReverseCommands,
  AdbReverseEntry,
  PortProbeOutcome,
} from "../../src/utils/android-cmdline-tools/adbReverse";
import type { DeviceListenerTable } from "../../src/utils/android-cmdline-tools/deviceTcpListeners";
import type {
  PortHttpProbeOutcome,
  PortHttpProbeRequest,
} from "../../src/utils/android-cmdline-tools/portHttpProbe";

/** adbd's uid on a user build; every reverse in `mappings` listens as it. */
export const FAKE_ADBD_UID = 2000;

/** An in-memory device: `mappings` is what `adb reverse --list` would print, keyed by device port. */
export class FakeAdbReverseCommands implements AdbReverseCommands {
  readonly mappings = new Map<number, string>();
  readonly calls: string[] = [];
  failList = false;
  failAdd = new Set<number>();
  failRemove = new Set<number>();
  /** Runs before an add is applied or refused, to simulate another tool acting meanwhile. */
  beforeAdd?: (devicePort: number) => void;
  /** While set, an add is recorded in `calls` but waits for this promise before it is applied. */
  addGate?: Promise<void>;

  /** Scripted probe outcomes per device port, consumed in order (the last one repeats). */
  readonly probeOutcomes = new Map<number, (PortProbeOutcome | "hang")[]>();

  /** When set, every probe rejects with it. */
  probeError: Error | undefined;

  async probe(devicePort: number): Promise<PortProbeOutcome> {
    this.calls.push(`probe ${devicePort}`);
    if (this.probeError !== undefined) {
      throw this.probeError;
    }
    const queue = this.probeOutcomes.get(devicePort) ?? [{ kind: "refused" }];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === "hang") {
      return new Promise<PortProbeOutcome>(() => {});
    }
    return next ?? { kind: "refused" };
  }

  /** Scripted HTTP probe outcomes per device port, consumed in order (the last one repeats). */
  readonly httpOutcomes = new Map<number, (PortHttpProbeOutcome | "hang")[]>();
  /** Every HTTP probe request, in order. */
  readonly httpRequests: { devicePort: number; request: PortHttpProbeRequest }[] = [];

  async httpProbe(
    devicePort: number,
    request: PortHttpProbeRequest,
  ): Promise<PortHttpProbeOutcome> {
    this.httpRequests.push({ devicePort, request });
    const queue = this.httpOutcomes.get(devicePort) ?? [{ kind: "refused" }];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === "hang") {
      return new Promise<PortHttpProbeOutcome>(() => {});
    }
    return next ?? { kind: "refused" };
  }

  async list(): Promise<AdbReverseEntry[]> {
    this.calls.push("list");
    if (this.failList) {
      throw new Error("device offline");
    }
    return [...this.mappings].map(([devicePort, host]) => {
      const hostPort = host.startsWith("tcp:") ? Number(host.slice(4)) : undefined;
      return hostPort === undefined ? { devicePort, host } : { devicePort, host, hostPort };
    });
  }

  async add(devicePort: number, hostPort: number, options?: { noRebind?: boolean }) {
    this.calls.push(`add ${devicePort} ${hostPort}${options?.noRebind ? " no-rebind" : ""}`);
    await this.addGate;
    this.beforeAdd?.(devicePort);
    if (this.failAdd.has(devicePort)) {
      throw new Error("adb: error: cannot bind");
    }
    if (this.processListeners.has(devicePort)) {
      throw new Error(`adb: error: cannot bind listener: Address already in use`);
    }
    if (options?.noRebind && this.mappings.has(devicePort)) {
      throw new Error("adb: error: cannot rebind existing socket");
    }
    this.mappings.set(devicePort, `tcp:${hostPort}`);
  }

  async remove(devicePort: number) {
    this.calls.push(`remove ${devicePort}`);
    if (this.failRemove.has(devicePort)) {
      throw new Error("adb: error: transport busy");
    }
    this.mappings.delete(devicePort);
  }

  /** Device ports held by other device processes, by uid (reverses are added from `mappings`). */
  readonly processListeners = new Map<number, number>();
  /** Installed packages by uid, as `pm list packages -U` would show them. */
  readonly packages = new Map<number, string>();
  /** When set, the listener table reads as this instead. */
  listenerTable: DeviceListenerTable | undefined;
  /** When set, reading the listener table rejects with it. */
  listenersError: Error | undefined;
  /** Listener-table reads and package lookups, kept out of `calls`. */
  readonly diagnosticCalls: string[] = [];

  async listeners(): Promise<DeviceListenerTable> {
    this.diagnosticCalls.push("listeners");
    if (this.listenersError !== undefined) {
      throw this.listenersError;
    }
    if (this.listenerTable !== undefined) {
      return this.listenerTable;
    }
    const listeners = new Map<number, number[]>();
    this.mappings.forEach((_host, port) => listeners.set(port, [FAKE_ADBD_UID]));
    this.processListeners.forEach((uid, port) => listeners.set(port, [uid]));
    return { kind: "ok", listeners };
  }

  /** When set, a package lookup rejects with it. */
  packageError: Error | undefined;

  async packageForUid(uid: number): Promise<string | undefined> {
    this.diagnosticCalls.push(`package ${uid}`);
    if (this.packageError !== undefined) {
      throw this.packageError;
    }
    return this.packages.get(uid);
  }

  /** Simulates a transport drop: adbd restarted and every reverse is gone. */
  dropAll(): void {
    this.mappings.clear();
  }
}
