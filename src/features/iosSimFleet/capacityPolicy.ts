import type { FleetCostReport, HostResources, SimulatorCost } from "./types";

const GIB = 1024 ** 3;

/** Env override: positive integer cap on concurrently booted simulators. */
export const IOS_SIM_MAX_BOOTED_ENV = "AUTOMOBILE_IOS_SIM_MAX_BOOTED";

/** Share of host RAM simulators may use; the rest stays for Xcode, the app under test and the OS. */
const MEMORY_BUDGET_FRACTION = 0.5;
const DEFAULT_PER_SIMULATOR_BYTES = 3 * GIB;
const MIN_PER_SIMULATOR_BYTES = 1.5 * GIB;
const MAX_PER_SIMULATOR_BYTES = 6 * GIB;
/** One booted simulator is budgeted two cores. */
const CORES_PER_SIMULATOR = 2;
const HIGH_LOAD_PER_CORE = 1.5;

export type MaxBootedSource = "env" | "derived";

export interface CapacityLimits {
  maxBooted: number;
  source: MaxBootedSource;
  /** Set when the env override was present but unusable. */
  warning?: string;
}

/** Observed per-simulator memory when we have measurements, else a conservative default. */
export function estimatePerSimulatorBytes(report?: FleetCostReport): number {
  const measured = (report?.simulators ?? []).flatMap((sim) =>
    sim.quality === "measured" && sim.process ? [sim.process.rssBytes] : [],
  );
  if (measured.length === 0) {
    return DEFAULT_PER_SIMULATOR_BYTES;
  }
  const average = measured.reduce((sum, bytes) => sum + bytes, 0) / measured.length;
  return Math.min(MAX_PER_SIMULATOR_BYTES, Math.max(MIN_PER_SIMULATOR_BYTES, average));
}

/**
 * Max concurrently booted simulators: the smaller of the memory budget and the
 * core budget (at least 1), unless the env override supplies a positive integer.
 */
export function resolveCapacityLimits(
  env: NodeJS.ProcessEnv,
  resources: Pick<HostResources, "totalMemoryBytes" | "cpuCount">,
  perSimulatorBytes: number = DEFAULT_PER_SIMULATOR_BYTES,
): CapacityLimits {
  const raw = env[IOS_SIM_MAX_BOOTED_ENV];
  const override = parseOverride(raw);
  if (override !== undefined) {
    return { maxBooted: override, source: "env" };
  }
  const byMemory = Math.floor(
    (resources.totalMemoryBytes * MEMORY_BUDGET_FRACTION) / perSimulatorBytes,
  );
  const byCpu = Math.floor(resources.cpuCount / CORES_PER_SIMULATOR);
  const derived: CapacityLimits = {
    maxBooted: Math.max(1, Math.min(byMemory, byCpu)),
    source: "derived",
  };
  return raw === undefined || raw.trim() === ""
    ? derived
    : {
        ...derived,
        warning: `${IOS_SIM_MAX_BOOTED_ENV}=${JSON.stringify(raw)} is not a positive integer; using the derived limit`,
      };
}

function parseOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  const value = Number(raw.trim());
  return value >= 1 ? value : undefined;
}

/** True for one sample that shows the host is under memory or CPU pressure. */
export function isPressured(resources: HostResources | undefined): boolean {
  if (!resources) {
    return false; // missing data is not pressure; the gate reports it separately
  }
  if (resources.memoryPressure === "warn" || resources.memoryPressure === "critical") {
    return true;
  }
  return (
    resources.loadAverage1m !== null &&
    resources.cpuCount > 0 &&
    resources.loadAverage1m / resources.cpuCount >= HIGH_LOAD_PER_CORE
  );
}

export interface WarmDeviceRequest {
  deviceTypeIdentifier?: string;
  runtime?: string;
  /** Profile identity; matched against the profile recorded with the last boot. */
  profileId?: string;
  /** Devices the caller knows are busy or owned elsewhere. */
  excludeUdids?: readonly string[];
}

/** Booted simulators that satisfy every compatibility field the request specifies. */
export function findWarmCompatibleDevices(
  report: FleetCostReport | undefined,
  request: WarmDeviceRequest,
): SimulatorCost[] {
  if (
    request.deviceTypeIdentifier === undefined &&
    request.runtime === undefined &&
    request.profileId === undefined
  ) {
    return []; // an unconstrained request names no compatibility, so no device is "compatible"
  }
  const excluded = new Set(request.excludeUdids ?? []);
  return (report?.simulators ?? []).filter(
    (sim) =>
      sim.state === "Booted" &&
      !excluded.has(sim.udid) &&
      (request.deviceTypeIdentifier === undefined ||
        sim.deviceTypeIdentifier === request.deviceTypeIdentifier) &&
      (request.runtime === undefined || sim.runtime === request.runtime) &&
      (request.profileId === undefined || sim.lastBoot?.profileId === request.profileId),
  );
}
