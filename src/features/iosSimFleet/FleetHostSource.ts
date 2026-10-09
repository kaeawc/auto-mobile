import { cpus, loadavg, totalmem } from "node:os";
import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { Timer } from "../../utils/SystemTimer";
import { PS_SNAPSHOT_ARGS, parsePsSnapshot } from "./psSnapshot";
import { SIMCTL_LIST_DEVICES_ARGS, parseSimctlInventory } from "./simctlInventory";
import type {
  HostResources,
  HostSnapshot,
  MemoryPressureLevel,
  SimulatorInventoryEntry,
} from "./types";

export interface FleetReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Read-only view of the host that the collector and capacity gate depend on. */
export interface FleetHostSource {
  readHostSnapshot(options?: FleetReadOptions): Promise<HostSnapshot>;
  readInventory(options?: FleetReadOptions): Promise<SimulatorInventoryEntry[]>;
}

/** Static host facts, injectable so tests do not depend on the machine running them. */
export interface HostOsInfo {
  totalMemoryBytes(): number;
  cpuCount(): number;
  loadAverage1m(): number | null;
}

export const nodeHostOsInfo: HostOsInfo = {
  totalMemoryBytes: () => totalmem(),
  cpuCount: () => cpus().length,
  loadAverage1m: () => {
    const load = loadavg()[0];
    // Windows reports 0 for every sample; treat that as "no data", not an idle host.
    return process.platform === "win32" ? null : load;
  },
};

const MEMORY_PRESSURE_SYSCTL = ["-n", "kern.memorystatus_vm_pressure_level"];

/** kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
export function parseMemoryPressureLevel(stdout: string): MemoryPressureLevel {
  switch (stdout.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return "unknown";
  }
}

/** Host source backed by `ps`, `sysctl` and `xcrun simctl list` (all read-only). */
export class CommandFleetHostSource implements FleetHostSource {
  constructor(
    private readonly executor: HostCommandExecutor,
    private readonly timer: Timer,
    private readonly os: HostOsInfo = nodeHostOsInfo,
  ) {}

  async readHostSnapshot(options: FleetReadOptions = {}): Promise<HostSnapshot> {
    const [ps, resources] = await Promise.all([
      this.executor.executeCommand("ps", PS_SNAPSHOT_ARGS, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      }),
      this.readResources(options),
    ]);
    const { rows, skipped } = parsePsSnapshot(ps.stdout);
    if (rows.length === 0) {
      throw new Error(`ps returned no parseable processes (${skipped} unparseable rows)`);
    }
    return { takenAtMs: this.timer.now(), resources, processes: rows };
  }

  async readInventory(options: FleetReadOptions = {}): Promise<SimulatorInventoryEntry[]> {
    const result = await this.executor.executeCommand("xcrun", SIMCTL_LIST_DEVICES_ARGS, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return parseSimctlInventory(result.stdout);
  }

  private async readResources(options: FleetReadOptions): Promise<HostResources> {
    return {
      totalMemoryBytes: this.os.totalMemoryBytes(),
      cpuCount: this.os.cpuCount(),
      loadAverage1m: this.os.loadAverage1m(),
      memoryPressure: await this.readMemoryPressure(options),
    };
  }

  private async readMemoryPressure(options: FleetReadOptions): Promise<MemoryPressureLevel> {
    try {
      const result = await this.executor.executeCommand("sysctl", MEMORY_PRESSURE_SYSCTL, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      return parseMemoryPressureLevel(result.stdout);
    } catch (error) {
      // Pressure is an optional signal (absent off macOS); "unknown" never counts as pressure.
      logger.debug(`memory pressure read failed: ${errorMessage(error)}`);
      return "unknown";
    }
  }
}
