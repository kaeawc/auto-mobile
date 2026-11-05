import type {
  AdbReverseCommands,
  AdbReverseEntry,
  PortProbeOutcome,
} from "../../src/utils/android-cmdline-tools/adbReverse";

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

  /** Simulates a transport drop: adbd restarted and every reverse is gone. */
  dropAll(): void {
    this.mappings.clear();
  }
}
