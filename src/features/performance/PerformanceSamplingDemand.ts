import type { MonitoredDevice, PerformanceDemandProbe } from "./PerformanceMonitorTypes";

export const PERF_WINDOW_LEASE_MS = 5 * 60 * 1000;
export const alwaysSample: PerformanceDemandProbe = {
  hasDemand: (_deviceId, _packageName, _platform) => true,
};

/** Clear interval baselines in place without changing identity, SDK ingest or health history. */
export function resetSamplingBaselines(device: MonitoredDevice): void {
  device.lastFastTick = 0;
  device.lastMediumTick = 0;
  device.lastSlowTick = 0;
  device.cachedCpu = null;
  device.cachedMemory = null;
  device.cachedMemoryBreakdown = null;
  device.cachedFps = null;
  device.cachedFrameTime = null;
  device.cachedTouchLatency = null;
  device.cachedPid = null;
  device.prevJankCounters = null;
  device.previousCpuSample = null;
  device.gfxPrimed = false;
}

/** Device-scoped observe leases and demand gaps, independent of monitoring registration. */
export class PerformanceSamplingDemand {
  private readonly perfWindowLeaseUntil = new Map<string, number>();
  private readonly dormantDevices = new Set<string>();

  constructor(private readonly probe: PerformanceDemandProbe) {}

  requestPerfWindow(deviceId: string, now: number): void {
    this.perfWindowLeaseUntil.set(deviceId, now + PERF_WINDOW_LEASE_MS);
  }

  shouldSample(device: MonitoredDevice, now: number): boolean {
    const demanded = this.probe.hasDemand(device.deviceId, device.packageName, device.platform);
    if (!demanded && now >= (this.perfWindowLeaseUntil.get(device.deviceId) ?? 0)) {
      this.dormantDevices.add(device.deviceId);
      return false;
    }
    if (this.dormantDevices.delete(device.deviceId)) {
      resetSamplingBaselines(device);
    }
    return true;
  }

  register(deviceId: string): void {
    this.dormantDevices.delete(deviceId);
  }

  remove(deviceId: string): void {
    this.perfWindowLeaseUntil.delete(deviceId);
    this.dormantDevices.delete(deviceId);
  }

  clear(): void {
    this.perfWindowLeaseUntil.clear();
    this.dormantDevices.clear();
  }
}
