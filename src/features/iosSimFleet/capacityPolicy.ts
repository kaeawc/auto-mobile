import {
  estimatePerDeviceBytes,
  estimateSettledPerDeviceBytes,
  IOS_SIMULATOR_MEMORY_POLICY,
  resolveBootCapacityLimits,
  type CapacityLimits,
  type InFlightBootMemory,
} from "../bootAdmission/capacityLimits";
import type { FleetCostReport, HostResources, SimulatorCost } from "./types";
import { ENV } from "../../config/env";

export type { CapacityLimits } from "../bootAdmission/capacityLimits";

/** Env override: positive integer cap on concurrently booted simulators. */
export const IOS_SIM_MAX_BOOTED_ENV = ENV.IOS_SIM_MAX_BOOTED.name;

const HIGH_LOAD_PER_CORE = 1.5;

/** Settled simulator memory, charging active admissions and external Booting devices conservatively. */
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
  const namedBoots = new Set(inFlight.flatMap((boot) => (boot.deviceId ? [boot.deviceId] : [])));
  for (const sim of simulators) {
    if (sim.state === "Booting") {
      namedBoots.add(sim.udid);
    }
  }
  const anonymousBoots = inFlight.filter((boot) => boot.deviceId === undefined);
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
    ...anonymousBoots,
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
 * core budget (at least 1), unless the env override supplies a positive integer.
 */
export function resolveCapacityLimits(
  env: NodeJS.ProcessEnv,
  resources: Pick<HostResources, "totalMemoryBytes" | "cpuCount">,
  perSimulatorBytes: number = IOS_SIMULATOR_MEMORY_POLICY.defaultBytes,
): CapacityLimits {
  return resolveBootCapacityLimits(env, IOS_SIM_MAX_BOOTED_ENV, resources, perSimulatorBytes);
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
