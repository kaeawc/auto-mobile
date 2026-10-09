import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import { defaultTimer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { InMemoryBootDurationHistory } from "../../features/iosSimFleet/BootDurationHistory";
import {
  IosSimFleetCostCollector,
  type FleetCostSource,
} from "../../features/iosSimFleet/FleetCostCollector";
import { CommandFleetHostSource } from "../../features/iosSimFleet/FleetHostSource";
import {
  estimatePerSimulatorBytes,
  isPressured,
  resolveCapacityLimits,
} from "../../features/iosSimFleet/capacityPolicy";
import { formatBytes, formatFleetReport } from "../../features/iosSimFleet/fleetReport";
import type { CheckResult, DoctorProbeOptions } from "../types";
import { remainingDoctorProbe } from "../deadline";

const CHECK_NAME = "iOS Simulator Fleet Cost";

export interface IosSimFleetDoctorDependencies {
  platform: () => NodeJS.Platform;
  createFleetSource: () => FleetCostSource;
  env: () => NodeJS.ProcessEnv;
}

export function createIosSimFleetDoctorDependencies(): IosSimFleetDoctorDependencies {
  return {
    platform: () => process.platform,
    createFleetSource: () =>
      new IosSimFleetCostCollector(
        new CommandFleetHostSource(new DefaultHostCommandExecutor(), defaultTimer),
        new InMemoryBootDurationHistory(),
        defaultTimer,
      ),
    env: () => process.env,
  };
}

/**
 * Read-only fleet report: process memory/CPU per booted simulator, device data
 * on disk, and whether one more boot would exceed the capacity policy.
 */
export async function checkIosSimulatorFleetCost(
  dependencies: IosSimFleetDoctorDependencies = createIosSimFleetDoctorDependencies(),
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  if (dependencies.platform() !== "darwin") {
    return { name: CHECK_NAME, status: "skip", message: "iOS simulators only available on macOS" };
  }
  try {
    const current = remainingDoctorProbe(probe);
    const report = await dependencies
      .createFleetSource()
      .collect({ signal: current.signal, timeoutMs: current.timeoutMs });
    if (!report.host) {
      return {
        name: CHECK_NAME,
        status: "skip",
        message: "Could not read host resources",
        detail: formatFleetReport(report).join("\n"),
      };
    }
    const limits = resolveCapacityLimits(
      dependencies.env(),
      report.host,
      estimatePerSimulatorBytes(report),
    );
    const booted = report.totals.bootedCount;
    const atCapacity = booted >= limits.maxBooted;
    const pressured = isPressured(report.host);
    const degraded = report.errors.length > 0 || atCapacity || pressured;
    return {
      name: CHECK_NAME,
      status: degraded ? "warn" : "pass",
      message: `${booted}/${limits.maxBooted} booted simulators (limit ${limits.source}), ${formatBytes(report.totals.rssBytes)} RSS, ${formatBytes(report.totals.diskBytes)} device data${atCapacity ? "; a new boot would exceed capacity" : ""}${pressured ? "; host under pressure" : ""}`,
      value: booted,
      detail: formatFleetReport(report).join("\n"),
      recommendation: atCapacity
        ? "Shut down an idle simulator or raise AUTOMOBILE_IOS_SIM_MAX_BOOTED"
        : undefined,
    };
  } catch (error) {
    remainingDoctorProbe(probe);
    logger.warn(`Simulator fleet cost check failed: ${errorMessage(error)}`, error);
    return {
      name: CHECK_NAME,
      status: "skip",
      message: `Could not measure: ${errorMessage(error)}`,
    };
  }
}
