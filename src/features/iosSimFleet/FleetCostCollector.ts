import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { BootDurationHistory } from "./BootDurationHistory";
import type { FleetHostSource, FleetReadOptions } from "./FleetHostSource";
import { attributeSimulatorProcesses } from "./psSnapshot";
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

/** UDIDs of simulators holding a capacity slot, optionally leaving out the boot's own target. */
export function occupyingUdids(report: FleetCostReport, excludeUdid?: string): string[] {
  return report.simulators
    .filter((sim) => SLOT_OCCUPYING_STATES.has(sim.state) && sim.udid !== excludeUdid)
    .map((sim) => sim.udid);
}

/** Narrow consumer-facing seam: anything that can produce a fleet cost report. */
export interface FleetCostSource {
  collect(options?: FleetReadOptions): Promise<FleetCostReport>;
}

/**
 * Measures whole-simulator cost from ONE host snapshot per batch. Missing data
 * is reported through `quality`/`error`, never as zero. Collection is
 * single-flight and touches no session, epoch or runner state.
 */
export class IosSimFleetCostCollector implements FleetCostSource {
  private inFlight: Promise<FleetCostReport> | null = null;

  constructor(
    private readonly source: FleetHostSource,
    private readonly history: BootDurationHistory,
    private readonly timer: Timer,
  ) {}

  collect(options: FleetReadOptions = {}): Promise<FleetCostReport> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const run = this.collectOnce(options).finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    });
    this.inFlight = run;
    return run;
  }

  private async collectOnce(options: FleetReadOptions): Promise<FleetCostReport> {
    const collectedAtMs = this.timer.now();
    let inventory: SimulatorInventoryEntry[];
    try {
      inventory = await this.source.readInventory(options);
    } catch (error) {
      logger.warn(`simulator inventory failed: ${errorMessage(error)}`, error);
      return emptyReport(collectedAtMs, [`inventory: ${errorMessage(error)}`]);
    }
    const booted = inventory.filter((entry) => entry.state === BOOTED_STATE);
    const snapshot = await this.readSnapshot(options, booted.length > 0);
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
    options: FleetReadOptions,
    reportFailure: boolean,
  ): Promise<{ value?: HostSnapshot; error?: string }> {
    try {
      return { value: await this.source.readHostSnapshot(options) };
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
    if (!snapshot.value) {
      return { ...base, quality: "unavailable", error: snapshot.error ?? "no host snapshot" };
    }
    const process = attribution.get(entry.udid);
    return process
      ? { ...base, quality: "measured", process }
      : { ...base, quality: "no-processes" };
  }
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
