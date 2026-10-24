import {
  estimatePerDeviceBytes,
  estimateSettledPerDeviceBytes,
  IOS_SIMULATOR_MEMORY_POLICY,
  MEMORY_BUDGET_FRACTION,
  parseOverride,
  type CapacityLimits,
  type InFlightBootMemory,
} from "../bootAdmission/capacityLimits";
import type { FleetCostReport, HostResources, SimulatorCost } from "./types";
import { ENV } from "../../config/env";

export type { CapacityLimits } from "../bootAdmission/capacityLimits";

/** Env override: positive integer cap on concurrently booted simulators. */
export const IOS_SIM_MAX_BOOTED_ENV = ENV.IOS_SIM_MAX_BOOTED.name;

/** Settled Apple processes (0.04 core) plus AutoMobile (0.015 core), measured in #15097. */
export const SETTLED_CPU_CORES_PER_SIMULATOR = 0.04 + 0.015;
/** Leave half the cores for the app under test, IDE and runners. */
export const CPU_BUDGET_FRACTION = 0.5;
/** First-boot bursts consume about 13 cores for 50–130 seconds (#15097). */
export const BOOT_BURST_CORES = 13;
/**
 * Derived boot concurrency never drops below 2 on a readable host: CPU-seconds are conserved, so
 * serializing boots cannot beat two overlapping ones by much, but a queue of one makes the third
 * concurrent caller wait out two full bursts and risk its outer deadline. Matches the runner
 * launch gate's default (#15103).
 */
export const MIN_DERIVED_BOOT_CONCURRENCY = 2;
export const IOS_SIM_BOOT_CONCURRENCY_ENV = ENV.IOS_SIM_BOOT_CONCURRENCY.name;

export interface IosCapacityLimits extends CapacityLimits {
  bootConcurrency: number;
  bootConcurrencySource: "env" | "derived";
  bootConcurrencyWarning?: string;
}

const HIGH_LOAD_PER_CORE = 1.5;

/**
 * Whole simulator-tree RSS includes the CtrlProxy runner app; no extra runner charge.
 * Average measured settled RSS is clamped to 1.5–6 GiB, falling back to 3 GiB.
 * Settled simulator memory, charging active admissions and external Booting devices conservatively.
 */
export function estimatePerSimulatorBytes(
  report?: FleetCostReport,
  inFlight: readonly InFlightBootMemory[] = [],
): number {
  const simulators = report?.simulators ?? [];
  const measured = simulators.flatMap((sim) =>
    sim.quality === "measured" && sim.process
      ? [{ udid: sim.udid, rssBytes: sim.process.rssBytes }]
      : [],
  );
  // Replacement reservations are anonymous charges; the old simulator's RSS stays settled.
  const namedBoots = new Set(
    inFlight.flatMap((boot) => (boot.deviceId && !boot.replacement ? [boot.deviceId] : [])),
  );
  for (const sim of simulators) {
    if (sim.state === "Booting") {
      namedBoots.add(sim.udid);
    }
  }
  const anonymousBoots = inFlight.filter((boot) => boot.deviceId === undefined || boot.replacement);
  if (namedBoots.size === 0 && anonymousBoots.length === 0) {
    return estimatePerDeviceBytes(
      measured.map((sim) => sim.rssBytes),
      IOS_SIMULATOR_MEMORY_POLICY,
    );
  }
  // Each RSS row is already a whole simulator tree. Use its row index as a sample-local identity
  // for the shared process matcher; no PID is available (or needed) in SimulatorProcessCost.
  const rowIds = new Map(measured.map((sim, index) => [sim.udid, index]));
  const boots: InFlightBootMemory[] = [
    ...anonymousBoots.map(({ handedOff }) => ({ handedOff })),
    ...[...namedBoots].map((udid) => ({ processId: rowIds.get(udid), handedOff: false })),
  ];
  return estimateSettledPerDeviceBytes(
    measured.map((sim, index) => ({ rssBytes: sim.rssBytes, pid: index })),
    boots,
    IOS_SIMULATOR_MEMORY_POLICY,
  );
}

/**
 * Max concurrently booted simulators: the smaller of the memory budget and the
 * settled-CPU budget (at least 1), unless the env override supplies a positive integer.
 */
export function resolveCapacityLimits(
  env: NodeJS.ProcessEnv,
  resources: Pick<HostResources, "totalMemoryBytes" | "cpuCount">,
  perSimulatorBytes: number = IOS_SIMULATOR_MEMORY_POLICY.defaultBytes,
): IosCapacityLimits {
  const raw = env[IOS_SIM_MAX_BOOTED_ENV];
  const override = parseOverride(raw);
  const byMemory = Math.floor(
    (resources.totalMemoryBytes * MEMORY_BUDGET_FRACTION) / perSimulatorBytes,
  );
  const bySettledCpu = Math.floor(
    (resources.cpuCount * CPU_BUDGET_FRACTION) / SETTLED_CPU_CORES_PER_SIMULATOR,
  );
  const bootRaw = env[IOS_SIM_BOOT_CONCURRENCY_ENV];
  const parsedBootOverride = parseOverride(bootRaw);
  const bootOverride = Number.isSafeInteger(parsedBootOverride) ? parsedBootOverride : undefined;
  const warning = unusableOverrideWarning(IOS_SIM_MAX_BOOTED_ENV, raw, override);
  const bootConcurrencyWarning = unusableOverrideWarning(
    IOS_SIM_BOOT_CONCURRENCY_ENV,
    bootRaw,
    bootOverride,
  );
  return {
    maxBooted: override ?? Math.max(1, Math.min(byMemory, bySettledCpu)),
    source: override === undefined ? "derived" : "env",
    ...(warning ? { warning } : {}),
    bootConcurrency: bootOverride ?? deriveBootConcurrency(resources.cpuCount),
    bootConcurrencySource: bootOverride === undefined ? "derived" : "env",
    ...(bootConcurrencyWarning ? { bootConcurrencyWarning } : {}),
  };
}

/** Unreadable host (no cores reported) boots one at a time; otherwise `ceil(cores / 13)`, at least 2. */
function deriveBootConcurrency(cpuCount: number): number {
  return cpuCount > 0
    ? Math.max(MIN_DERIVED_BOOT_CONCURRENCY, Math.ceil(cpuCount / BOOT_BURST_CORES))
    : 1;
}

/** Shared warning wording for the two independent iOS overrides. */
function unusableOverrideWarning(
  name: string,
  raw: string | undefined,
  value: number | undefined,
): string | undefined {
  return value === undefined && raw?.trim()
    ? `${name}=${JSON.stringify(raw)} is not a positive integer; using the derived limit`
    : undefined;
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
