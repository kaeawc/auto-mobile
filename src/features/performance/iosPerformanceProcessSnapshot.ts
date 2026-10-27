import { parsePsSnapshot } from "../../devices/bootAdmission/psSnapshot";
import type { HostProcessRow } from "../../models/HostProcessRow";
import { logger } from "../../utils/logger";
import type { MonitoredDevice } from "./PerformanceMonitorTypes";

export type IOSPerformanceProcessResolver = (
  deviceId: string,
  packageName: string,
) => Promise<HostProcessRow | null>;

/** One lazy host snapshot per sampling tick, shared by every iOS device and metric. */
export function createIOSPerformanceProcessResolver(
  readSnapshot: () => Promise<{ stdout: string }>,
): IOSPerformanceProcessResolver {
  let snapshot: Promise<HostProcessRow[]> | undefined;
  return async (deviceId, packageName) => {
    snapshot ??= readSnapshot()
      .then(({ stdout }) => parsePsSnapshot(stdout).rows)
      .catch((error) => {
        // Host metrics are best-effort; retry with a fresh snapshot on the next due tick.
        logger.debug(`[PerformanceMonitor] iOS process metrics failed: ${error}`);
        return [];
      });
    const rows = await snapshot;
    // Re-resolve from each fresh snapshot: an app can exit or restart with a new PID.
    return (
      rows.find((row) => row.command.includes(deviceId) && row.command.includes(packageName)) ??
      null
    );
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
