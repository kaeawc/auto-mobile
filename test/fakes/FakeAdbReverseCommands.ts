import type {
  AdbReverseCommands,
  AdbReverseEntry,
} from "../../src/utils/android-cmdline-tools/adbReverse";

/** An in-memory device: `mappings` is what `adb reverse --list` would print, keyed by device port. */
export class FakeAdbReverseCommands implements AdbReverseCommands {
  readonly mappings = new Map<number, string>();
  readonly calls: string[] = [];
  failList = false;
  failAdd = new Set<number>();

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
    this.mappings.delete(devicePort);
  }

  /** Simulates a transport drop: adbd restarted and every reverse is gone. */
  dropAll(): void {
    this.mappings.clear();
  }
}
