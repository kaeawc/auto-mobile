import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  nodeHostOsInfo,
  readHostProcessTable,
  type HostOsInfo,
} from "../iosSimFleet/FleetHostSource";
import type { HostProcessRow } from "../iosSimFleet/types";
import type { CapacityHostResources } from "./capacityLimits";

/** What the Android boot admission gate counts. Missing data is reported, never read as zero load. */
export interface AndroidCapacitySample {
  /** adb serials of emulators in `device` state. */
  emulatorSerials: string[];
  /**
   * RSS of every `qemu-system-*` process on the host: emulators still booting,
   * and ones registered with another adb server, show up here before (or
   * instead of) the adb listing. Undefined when the process table was unreadable.
   */
  emulatorProcessRssBytes?: number[];
  host: CapacityHostResources;
  errors: string[];
}

export interface AndroidCapacitySource {
  sample(options?: { signal?: AbortSignal }): Promise<AndroidCapacitySample>;
}

/** Lists the adb serials of emulators in `device` state; throws when adb is unusable. */
export type EmulatorSerialLister = (signal?: AbortSignal) => Promise<string[]>;

/** The emulator's guest runs in a `qemu-system-<arch>` process (one per running emulator). */
export function isEmulatorQemuProcess(row: Pick<HostProcessRow, "command">): boolean {
  const executable = row.command.split(" -")[0] ?? "";
  const name = executable.slice(executable.lastIndexOf("/") + 1).trim();
  return name.startsWith("qemu-system-");
}

/** Read-only source backed by the adb listing, `ps` and the `os` host totals. */
export class CommandAndroidCapacitySource implements AndroidCapacitySource {
  constructor(
    private readonly listEmulatorSerials: EmulatorSerialLister,
    private readonly executor: HostCommandExecutor,
    private readonly os: Pick<HostOsInfo, "totalMemoryBytes" | "cpuCount"> = nodeHostOsInfo,
    private readonly readTimeoutMs = 5_000,
  ) {}

  async sample(options: { signal?: AbortSignal } = {}): Promise<AndroidCapacitySample> {
    const [serials, processes] = await Promise.all([
      this.readSerials(options.signal),
      this.readEmulatorProcesses(options.signal),
    ]);
    return {
      emulatorSerials: serials.value ?? [],
      emulatorProcessRssBytes: processes.value,
      host: { totalMemoryBytes: this.os.totalMemoryBytes(), cpuCount: this.os.cpuCount() },
      errors: [serials.error, processes.error].filter(
        (error): error is string => error !== undefined,
      ),
    };
  }

  private async readSerials(signal?: AbortSignal): Promise<{ value?: string[]; error?: string }> {
    try {
      return { value: await this.listEmulatorSerials(signal) };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[BootAdmission] adb emulator listing failed: ${errorMessage(error)}`, error);
      return { error: `adb: ${errorMessage(error)}` };
    }
  }

  private async readEmulatorProcesses(
    signal?: AbortSignal,
  ): Promise<{ value?: number[]; error?: string }> {
    try {
      const rows = await readHostProcessTable(this.executor, {
        signal,
        timeoutMs: this.readTimeoutMs,
      });
      return { value: rows.filter(isEmulatorQemuProcess).map((row) => row.rssBytes) };
    } catch (error) {
      signal?.throwIfAborted();
      // Optional signal: `ps` is absent on Windows, and the adb listing still counts emulators.
      logger.debug(`[BootAdmission] emulator process snapshot failed: ${errorMessage(error)}`);
      return { error: `ps: ${errorMessage(error)}` };
    }
  }
}
