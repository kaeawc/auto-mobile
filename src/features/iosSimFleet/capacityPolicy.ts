import {
  estimatePerDeviceBytes,
  IOS_SIMULATOR_MEMORY_POLICY,
  resolveBootCapacityLimits,
  type CapacityLimits,
} from "../bootAdmission/capacityLimits";
import type { FleetCostReport, HostResources, SimulatorCost } from "./types";

export type { CapacityLimits, MaxBootedSource } from "../bootAdmission/capacityLimits";

/** Env override: positive integer cap on concurrently booted simulators. */
export const IOS_SIM_MAX_BOOTED_ENV = "AUTOMOBILE_IOS_SIM_MAX_BOOTED";

const HIGH_LOAD_PER_CORE = 1.5;

/** Observed per-simulator memory when we have measurements, else a conservative default. */
export function estimatePerSimulatorBytes(report?: FleetCostReport): number {
  const measured = (report?.simulators ?? []).flatMap((sim) =>
    sim.quality === "measured" && sim.process ? [sim.process.rssBytes] : [],
  );
  return estimatePerDeviceBytes(measured, IOS_SIMULATOR_MEMORY_POLICY);
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
