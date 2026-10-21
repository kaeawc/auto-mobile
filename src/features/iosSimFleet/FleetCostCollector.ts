import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { withRemainingBudget } from "../../utils/withRemainingBudget";
import type { BootDurationHistory } from "./BootDurationHistory";
import type { FleetHostSource, FleetReadOptions } from "./FleetHostSource";
import { attributeSimulatorProcesses } from "../../devices/bootAdmission/psSnapshot";
import type {
  FleetCostReport,
  FleetCostTotals,
  HostSnapshot,
  SimulatorCost,
  SimulatorInventoryEntry,
  SimulatorProcessCost,
} from "./types";

export const BOOTED_STATE = "Booted";
/**
 * Simulator states that already hold a capacity slot: a booting or shutting-down
 * simulator uses CPU and memory although `simctl` does not list it as Booted (#11291).
 */
export const SLOT_OCCUPYING_STATES: ReadonlySet<string> = new Set([
  BOOTED_STATE,
  "Booting",
  "Shutting Down",
]);

/** Shared simulator-capacity states, independent of device bindings. */
export { SLOT_OCCUPYING_STATES as OCCUPYING_SIMULATOR_STATES };

/** UDIDs of simulators holding a capacity slot, optionally leaving out the boot's own target. */
export function occupyingUdids(report: FleetCostReport, excludeUdid?: string): string[] {
  return report.simulators
    .filter((sim) => SLOT_OCCUPYING_STATES.has(sim.state) && sim.udid !== excludeUdid)
    .map((sim) => sim.udid);
}

/**
 * Bounds for one whole collection run. `timeoutMs` is the run's total budget, measured from when
 * the run starts; `deadlineMs` (timer time) is an absolute end that wins over it. Either way the
 * listing and the host snapshot share the one budget: each phase gets only what is left (#14496).
 */
export interface FleetCollectOptions extends FleetReadOptions {
  deadlineMs?: number;
}

/** Narrow consumer-facing seam: anything that can produce a fleet cost report. */
export interface FleetCostSource {
  collect(options?: FleetCollectOptions): Promise<FleetCostReport>;
  /**
   * A report whose listing starts no earlier than this call. Callers that opened a ledger sample
   * window just before calling share one run, but never one that began before their window: it
   * could predate a boot released in between.
   */
  collectFresh(options?: FleetCollectOptions): Promise<FleetCostReport>;
}

/**
 * Measures whole-simulator cost from ONE host snapshot per batch. Missing data
 * is reported through `quality`/`error`, never as zero. Collection is
 * single-flight and touches no session, epoch or runner state.
 */
export class IosSimFleetCostCollector implements FleetCostSource {
  private inFlight: Promise<FleetCostReport> | null = null;
  /** A fresh run that has not started its listing yet; callers arriving before it joins it. */
  private pendingFresh: Promise<FleetCostReport> | null = null;

  constructor(
    private readonly source: FleetHostSource,
    private readonly history: BootDurationHistory,
    private readonly timer: Timer,
  ) {}

  collect(options: FleetCollectOptions = {}): Promise<FleetCostReport> {
    if (this.inFlight) {
      return this.inFlight;
    }
    return this.startRun(options);
  }

  collectFresh(options: FleetCollectOptions = {}): Promise<FleetCostReport> {
    if (this.pendingFresh) {
      return this.pendingFresh;
    }
    // Start on a microtask so every caller whose window opened in this turn shares the run.
    const batch = Promise.resolve().then(() => {
      this.pendingFresh = null;
      return this.startRun(options);
    });
    this.pendingFresh = batch;
    return batch;
  }

  private startRun(options: FleetCollectOptions): Promise<FleetCostReport> {
    const run = this.collectOnce(this.runBudget(options)).finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    });
    this.inFlight = run;
    return run;
  }

  /**
   * The run's one absolute deadline. Callers share a run and none cancels it when it stops
   * waiting, so the run itself must end by the budget its starter advertised (#14496).
   */
  private runBudget(options: FleetCollectOptions): RunBudget {
    const deadlineMs =
      options.deadlineMs ??
      (options.timeoutMs === undefined ? undefined : this.timer.now() + options.timeoutMs);
    return { signal: options.signal, deadlineMs };
  }

  /** Read one phase with only what is left of the run's budget; an elapsed one throws unread. */
  private async withinBudget<T>(
    budget: RunBudget,
    read: (options: FleetReadOptions) => Promise<T>,
  ): Promise<T> {
    if (budget.deadlineMs === undefined) {
      return await read({ signal: budget.signal });
    }
    return await withRemainingBudget(
      budget.deadlineMs,
      this.timer,
      budget.signal,
      (signal, timeoutMs) => read({ signal, timeoutMs }),
    );
  }

  private async collectOnce(budget: RunBudget): Promise<FleetCostReport> {
    const collectedAtMs = this.timer.now();
    let inventory: SimulatorInventoryEntry[];
    try {
      inventory = await this.withinBudget(budget, (options) => this.source.readInventory(options));
    } catch (error) {
      logger.warn(`simulator inventory failed: ${errorMessage(error)}`, error);
      return emptyReport(collectedAtMs, [`inventory: ${errorMessage(error)}`]);
    }
    const booted = inventory.filter((entry) => entry.state === BOOTED_STATE);
    const snapshot = await this.readSnapshot(budget, booted.length > 0);
    const attribution = snapshot.value
      ? attributeSimulatorProcesses(
          snapshot.value.processes,
          booted.map((entry) => entry.udid),
        )
      : new Map<string, SimulatorProcessCost>();
    const simulators = inventory.map((entry) => this.costFor(entry, snapshot, attribution));
    const errors = snapshot.error ? [`host snapshot: ${snapshot.error}`] : [];
    return {
      collectedAtMs,
      host: snapshot.value?.resources,
      simulators,
      totals: totalsOf(simulators),
      errors,
    };
  }

  private async readSnapshot(
    budget: RunBudget,
    reportFailure: boolean,
  ): Promise<{ value?: HostSnapshot; error?: string }> {
    try {
      // A listing that used up the budget leaves no time for the snapshot: it is not started.
      const value = await this.withinBudget(budget, (options) =>
        this.source.readHostSnapshot(options),
      );
      // A failed `ps` keeps the host totals but leaves per-process cost unmeasured.
      return reportFailure && value.processesError
        ? { value, error: value.processesError }
        : { value };
    } catch (error) {
      logger.warn(`host snapshot failed: ${errorMessage(error)}`, error);
      // With nothing booted there is nothing to attribute, so a failed read is not an error.
      return reportFailure ? { error: errorMessage(error) } : {};
    }
  }

  private costFor(
    entry: SimulatorInventoryEntry,
    snapshot: { value?: HostSnapshot; error?: string },
    attribution: Map<string, SimulatorProcessCost>,
  ): SimulatorCost {
    const base = {
      udid: entry.udid,
      name: entry.name,
      state: entry.state,
      runtime: entry.runtime,
      deviceTypeIdentifier: entry.deviceTypeIdentifier,
      diskBytes: entry.dataPathSizeBytes,
      lastBoot: this.history.latestFor(entry.udid),
    };
    if (entry.state !== BOOTED_STATE) {
      return { ...base, quality: "not-running" };
    }
    if (!snapshot.value || snapshot.value.processesError) {
      return {
        ...base,
        quality: "unavailable",
        error: snapshot.error ?? snapshot.value?.processesError ?? "no host snapshot",
      };
    }
    const process = attribution.get(entry.udid);
    return process
      ? { ...base, quality: "measured", process }
      : { ...base, quality: "no-processes" };
  }
}

interface RunBudget {
  signal?: AbortSignal;
  /** Timer time by which every phase of the run has ended; unbounded when absent. */
  deadlineMs?: number;
}

function emptyReport(collectedAtMs: number, errors: string[]): FleetCostReport {
  return { collectedAtMs, simulators: [], totals: totalsOf([]), errors, inventoryFailed: true };
}

function totalsOf(simulators: readonly SimulatorCost[]): FleetCostTotals {
  const measured = simulators.filter((sim) => sim.quality === "measured");
  return {
    bootedCount: simulators.filter((sim) => sim.state === BOOTED_STATE).length,
    measuredCount: measured.length,
    rssBytes: measured.reduce((sum, sim) => sum + (sim.process?.rssBytes ?? 0), 0),
    cpuPercent: measured.reduce((sum, sim) => sum + (sim.process?.cpuPercent ?? 0), 0),
    diskBytes: simulators.reduce((sum, sim) => sum + (sim.diskBytes ?? 0), 0),
  };
}
