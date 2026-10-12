import type { AdbDeviceState } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { nodeHostOsInfo, type HostOsInfo } from "../iosSimFleet/FleetHostSource";
import type { HostProcessRow } from "../iosSimFleet/types";
import {
  ProcessTableReader,
  type ProcessTableReadOptions,
  type ProcessTableFailure,
} from "./processTableRetry";
import type { CapacityHostResources } from "./capacityLimits";

export type { ProcessTableFailure, ProcessTableFailureReason } from "./processTableRetry";

/** What the Android boot admission gate counts. Missing data is reported, never read as zero load. */
export interface AndroidCapacitySample {
  /**
   * adb serials of emulators in any adb state: one that is `offline` (still booting) or
   * `unauthorized` already runs and holds a slot, whoever launched it (#11369).
   */
  emulatorSerials: string[];
  /**
   * RSS of every `qemu-system-*` process on the host: emulators still booting,
   * and ones registered with another adb server, show up here before (or
   * instead of) the adb listing. Undefined when the process table was unreadable.
   */
  emulatorProcessRssBytes?: number[];
  /**
   * The pid and parent pid of each of those processes, in the same order. A boot the gate
   * admitted is matched to its own process by the pid of the launcher this daemon spawned: the
   * launcher becomes the qemu process or is its parent. Absent when the source cannot tell,
   * and then no admitted boot is matched to a process.
   */
  emulatorProcessIds?: Array<{ pid: number; ppid: number }>;
  host: CapacityHostResources;
  errors: string[];
  /**
   * The adb listing failed, so `emulatorSerials` is empty for want of data, not because no
   * emulator runs. With no process count either, the booted count is unknown (#11236).
   */
  serialListingFailed?: true;
  /** Why the host process table is unavailable; absent exactly when that table was read. */
  processTableFailure?: ProcessTableFailure;
}

export interface AndroidCapacitySource {
  sample(options?: { signal?: AbortSignal; deadlineMs?: number }): Promise<AndroidCapacitySample>;
}

/** Lists the adb serials of emulators in any adb state; throws when adb is unusable. */
export type EmulatorSerialLister = (signal?: AbortSignal) => Promise<string[]>;

/** The raw `adb devices` rows, including devices that are not online yet. */
export interface AdbDeviceStateSource {
  getDeviceStates(options: {
    timeoutMs: number;
    signal?: AbortSignal;
    throwOnMissingAdb: true;
  }): Promise<AdbDeviceState[]>;
}

/**
 * Emulator serials from the raw adb states rather than the online-only device list: with no
 * process table (Windows, or a failed `ps`) the listing is the only count, and an emulator a
 * peer daemon or a person is still booting is listed `offline` before it is `device` (#11369).
 */
export function adbEmulatorSerialLister(
  adb: AdbDeviceStateSource,
  timeoutMs: number,
): EmulatorSerialLister {
  return async (signal) => {
    const states = await adb.getDeviceStates({ timeoutMs, signal, throwOnMissingAdb: true });
    const serials = states
      .map((state) => state.deviceId)
      .filter((deviceId) => deviceId.startsWith("emulator-"));
    return [...new Set(serials)];
  };
}

/** The SDK's own layout: `<sdk>/emulator/qemu/<os>-<arch>/qemu-system-<arch>[-headless]`. */
const SDK_QEMU_EXECUTABLE = /\/qemu\/[^/\s]+\/qemu-system-[^/\s]*(?:\s|$)/;

/**
 * The emulator's guest runs in a `qemu-system-<arch>` process (one per running emulator).
 *
 * `ps` prints the command line with no quoting, so where the executable path ends is a guess:
 * it is taken to end before the first ` -`, which keeps a path with spaces whole. A directory
 * whose name holds ` -` ("OneDrive - Work") cuts that guess short and hid the emulator from the
 * count (#11588), so a command naming the SDK's qemu executable counts wherever its path was cut.
 * A wrong guess that way round counts a process that is not an emulator: fail closed.
 */
export function isEmulatorQemuProcess(row: Pick<HostProcessRow, "command">): boolean {
  const executable = row.command.split(" -")[0] ?? "";
  const name = executable.slice(executable.lastIndexOf("/") + 1).trim();
  return name.startsWith("qemu-system-") || SDK_QEMU_EXECUTABLE.test(row.command);
}

/** Read-only source backed by the adb listing, `ps` and the `os` host totals. */
export class CommandAndroidCapacitySource implements AndroidCapacitySource {
  private readonly processTable: ProcessTableReader;
  constructor(
    private readonly listEmulatorSerials: EmulatorSerialLister,
    executor: HostCommandExecutor,
    private readonly os: Pick<HostOsInfo, "totalMemoryBytes" | "cpuCount"> = nodeHostOsInfo,
    options: ProcessTableReadOptions = {},
  ) {
    this.processTable = new ProcessTableReader(executor, options);
  }

  /**
   * adb is read first and the process table only once that read has ended (#11588). An emulator
   * adb lists already has a process, so a table read afterwards shows every emulator the listing
   * shows that still runs, and the table alone is a floor for the count. Read the other way
   * round, or overlapping, an emulator started and listed after the table was read and another
   * one only the table shows are one row in each listing: two emulators counted as one.
   *
   * The healthy path costs one `ps` on top of the adb read instead of alongside it: 60 to 120 ms measured
   * on a loaded macOS host with 1,200 processes.
   * Process-table retries share the caller's sample deadline. A failed adb read still leaves
   * the table to count by.
   */
  async sample(
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<AndroidCapacitySample> {
    const serials = await this.readSerials(options.signal);
    const processes = await this.processTable.read(options);
    const emulatorRows = processes.value?.filter(isEmulatorQemuProcess);
    return {
      emulatorSerials: serials.value ?? [],
      emulatorProcessRssBytes: emulatorRows?.map((row) => row.rssBytes),
      emulatorProcessIds: emulatorRows?.map((row) => ({ pid: row.pid, ppid: row.ppid })),
      host: { totalMemoryBytes: this.os.totalMemoryBytes(), cpuCount: this.os.cpuCount() },
      errors: [serials.error, processes.error].filter(
        (error): error is string => error !== undefined,
      ),
      ...(processes.failure ? { processTableFailure: processes.failure } : {}),
      ...(serials.error !== undefined ? { serialListingFailed: true as const } : {}),
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
}
