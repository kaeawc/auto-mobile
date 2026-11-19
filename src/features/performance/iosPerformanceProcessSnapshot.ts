import { parsePsSnapshot } from "../../devices/bootAdmission/psSnapshot";
import type { HostProcessRow } from "../../models/HostProcessRow";
import { findIosSimulatorAppProcessId } from "../../utils/ios-cmdline-tools/IosCrashBackend";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { logger } from "../../utils/logger";
import type { MonitoredDevice, SimCtlClientFactory } from "./PerformanceMonitorTypes";

const PID_LOOKUP_TIMEOUT_MS = 5_000;

export type IOSPerformanceProcessResolver = (
  deviceId: string,
  packageName: string,
) => Promise<HostProcessRow | null>;

/** One lazy host snapshot per sampling tick, shared by every iOS device and metric. */
export function createIOSPerformanceProcessResolver(
  readSnapshot: () => Promise<{ stdout: string }>,
  simCtlClientFactory: SimCtlClientFactory,
): IOSPerformanceProcessResolver {
  let snapshot: Promise<HostProcessRow[]> | undefined;
  return async (deviceId, packageName) => {
    if (resolveIosDeviceKind({ deviceId }) !== "simulator") {
      return null;
    }

    // Resolve against this simulator's launchd on every due tick since apps can restart.
    let pid: number | null;
    try {
      const { stdout } = await simCtlClientFactory
        .create(deviceId)
        .executeCommandArgs(["spawn", deviceId, "launchctl", "list"], PID_LOOKUP_TIMEOUT_MS);
      pid = findIosSimulatorAppProcessId(stdout, packageName);
    } catch (error) {
      // The simulator can shut down between ticks. Publish unavailable host metrics this tick.
      logger.warn(`[PerformanceMonitor] iOS process lookup failed for ${deviceId}`, error);
      return null;
    }
    if (pid === null) {
      return null;
    }

    snapshot ??= readSnapshot()
      .then(({ stdout }) => parsePsSnapshot(stdout).rows)
      .catch((error) => {
        // Host metrics are best-effort; retry with a fresh snapshot on the next due tick.
        logger.debug(`[PerformanceMonitor] iOS process metrics failed: ${error}`);
        return [];
      });
    const rows = await snapshot;
    return rows.find((row) => row.pid === pid) ?? null;
  };
}

/** Keep cached stream values between their original CPU and memory collection tiers. */
export async function collectIOSPerformanceMetrics(
  device: MonitoredDevice,
  cpuDue: boolean,
  memoryDue: boolean,
  resolveProcess: IOSPerformanceProcessResolver,
): Promise<{ cpu: number | null; memory: number | null; pid: number | null }> {
  if (!cpuDue && !memoryDue) {
    return { cpu: device.cachedCpu, memory: device.cachedMemory, pid: device.cachedPid };
  }
  const row = await resolveProcess(device.deviceId, device.packageName);
  return {
    cpu: cpuDue ? (row ? Math.min(row.cpuPercent, 100) : null) : device.cachedCpu,
    memory: memoryDue ? (row ? row.rssBytes / 1024 ** 2 : null) : device.cachedMemory,
    pid: row?.pid ?? null,
  };
}
