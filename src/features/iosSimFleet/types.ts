/**
 * Shared types for iOS Simulator fleet cost measurement and capacity (#6696).
 * Everything here is read-only host telemetry; nothing mutates a simulator.
 */

/** One row of the host process table (`ps -axo pid=,ppid=,rss=,pcpu=,command=`). */
export interface HostProcessRow {
  pid: number;
  ppid: number;
  /** Resident set size in bytes (ps reports KiB). Shared pages are counted per process. */
  rssBytes: number;
  /** ps `%cpu`: decayed cputime/realtime ratio, not an instantaneous sample. */
  cpuPercent: number;
  command: string;
}

export type MemoryPressureLevel = "normal" | "warn" | "critical" | "unknown";

/** Host-wide numbers read once per batch so every simulator shares one view. */
export interface HostResources {
  totalMemoryBytes: number;
  cpuCount: number;
  /** 1-minute load average, or null when the platform reports none. */
  loadAverage1m: number | null;
  memoryPressure: MemoryPressureLevel;
}

export interface HostSnapshot {
  takenAtMs: number;
  resources: HostResources;
  processes: HostProcessRow[];
}

/** Simulator facts from `simctl list devices -j`, including its own data-dir size. */
export interface SimulatorInventoryEntry {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  deviceTypeIdentifier?: string;
  /** Size of the device data directory in bytes, when simctl reported it. */
  dataPathSizeBytes?: number;
  isAvailable: boolean;
}

export interface SimulatorProcessCost {
  processCount: number;
  rssBytes: number;
  cpuPercent: number;
}

/**
 * - `measured`: the process tree was found and summed.
 * - `no-processes`: simulator is Booted but no tagged process was visible
 *   (never reported as zero cost).
 * - `not-running`: simulator is not Booted, so it has no process cost.
 * - `unavailable`: the host snapshot failed; `error` says why.
 */
export type MeasurementQuality = "measured" | "no-processes" | "not-running" | "unavailable";

export interface BootDurationSample {
  udid: string;
  /** Workload/profile identity so durations compare across configurations. */
  profileId: string;
  durationMs: number;
  recordedAtMs: number;
}

export interface SimulatorCost {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  deviceTypeIdentifier?: string;
  quality: MeasurementQuality;
  /** Present only when `quality` is `measured`. */
  process?: SimulatorProcessCost;
  /** Device data dir size; absent when simctl did not report it. */
  diskBytes?: number;
  lastBoot?: BootDurationSample;
  error?: string;
}

export interface FleetCostTotals {
  bootedCount: number;
  measuredCount: number;
  rssBytes: number;
  cpuPercent: number;
  diskBytes: number;
}

export interface FleetCostReport {
  collectedAtMs: number;
  host?: HostResources;
  simulators: SimulatorCost[];
  totals: FleetCostTotals;
  /** Collection-level errors (inventory or host snapshot); never silently empty. */
  errors: string[];
  /** True when `simctl list` failed: `simulators` is then unknown, not empty (#11280). */
  inventoryFailed?: boolean;
}
