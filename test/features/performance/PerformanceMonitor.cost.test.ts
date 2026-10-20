import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { registerPerformanceMonitorSessionCleanup } from "../../../src/daemon/performanceMonitorSessionCleanup";
import type { LivePerformanceData } from "../../../src/daemon/performancePushSocketServer";
import { parsePsSnapshot, PS_SNAPSHOT_ARGS } from "../../../src/devices/bootAdmission/psSnapshot";
import { PerformanceMonitor } from "../../../src/features/performance/PerformanceMonitor";
import {
  PerfWindowBuffer,
  type PerfSample,
} from "../../../src/features/performance/PerfWindowBuffer";
import { SdkFrameMetricsStore } from "../../../src/features/performance/SdkFrameMetricsStore";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSessionCleanupManager } from "../../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";

const capture = readFileSync(
  new URL("../../fixtures/ios-sim-fleet/ps-snapshot-two-booted-simulators.txt", import.meta.url),
  "utf8",
);
const deviceA = "2300914A-231E-4874-8F8A-40C3D2F1E24B";
const deviceB = "BCC31307-1A19-4D67-A7F0-44FC98F78921";

function advanceTime(timer: FakeTimer, ms: number): Promise<void> {
  return timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));
}

class CountingTimer extends FakeTimer {
  wakeups = 0;
  override setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    return super.setInterval(() => {
      this.wakeups++;
      callback();
    }, ms);
  }
}

class RecordingBuffer extends PerfWindowBuffer {
  readonly recorded: { deviceId: string; sample: PerfSample }[] = [];
  override record(deviceId: string, sample: PerfSample): void {
    this.recorded.push({ deviceId, sample });
    super.record(deviceId, sample);
  }
}

/** Serve the existing capture, including the original command format for before/after proof. */
class SnapshotExec {
  stdout = capture;
  error: Error | null = null;
  readonly calls: { file: string; args: string[] }[] = [];
  execute = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    this.calls.push({ file, args });
    if (this.error) {
      throw this.error;
    }
    const stdout =
      args[0] === "aux"
        ? parsePsSnapshot(this.stdout)
            .rows.map(
              (row) =>
                `mobile ${row.pid} ${row.cpuPercent} 0 0 ${row.rssBytes / 1024} ?? S 0 0 ${row.command}`,
            )
            .join("\n")
        : this.stdout;
    return { stdout, stderr: "" };
  };
}

const monitors: PerformanceMonitor[] = [];
function setup() {
  const timer = new CountingTimer();
  const exec = new SnapshotExec();
  const buffer = new RecordingBuffer();
  const pushes: LivePerformanceData[] = [];
  const monitor = new PerformanceMonitor(timer, {
    adbClientFactory: new FakeAdbClientFactory(),
    execFileAsync: exec.execute,
    serverGetter: () => ({
      pushPerformanceData: (data) => {
        pushes.push(data);
      },
    }),
    perfWindowBuffer: buffer,
    frameMetricsStore: new SdkFrameMetricsStore(),
    getTelemetryEmitter: () => ({ setContext: () => {}, recordPerformanceEvent: () => {} }),
  });
  monitors.push(monitor);
  return { timer, exec, buffer, pushes, monitor };
}

afterEach(() => {
  for (const monitor of monitors) {
    monitor.stop();
  }
  monitors.length = 0;
});

describe("PerformanceMonitor subprocess and timer cost", () => {
  test("zero devices cause zero interval wakeups over one simulated minute", async () => {
    const { timer, monitor } = setup();
    monitor.start();
    monitor.start();
    await advanceTime(timer, 60000);
    console.log(`idle wakeups / simulated minute: ${timer.wakeups}`);
    expect(timer.wakeups).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("first registration arms one interval; last removal clears it and registration restarts it", async () => {
    const { timer, monitor, pushes } = setup();
    monitor.startMonitoring(deviceA, "Playground", "ios");
    expect(timer.getPendingIntervalCount()).toBe(1);
    monitor.start();
    monitor.start();
    monitor.startMonitoring(deviceB, "launchd_sim", "ios");
    monitor.startMonitoring(deviceA, "Playground", "ios");
    expect(timer.getPendingIntervalCount()).toBe(1);
    await advanceTime(timer, 500);
    expect(pushes).toHaveLength(2);
    monitor.stopMonitoring(deviceA);
    expect(timer.getPendingIntervalCount()).toBe(1);
    monitor.stopMonitoring(deviceB);
    expect(timer.getPendingIntervalCount()).toBe(0);
    monitor.stopMonitoring("missing");
    await advanceTime(timer, 60000);
    expect(timer.wakeups).toBe(1);
    monitor.startMonitoring(deviceA, "Playground", "ios");
    await advanceTime(timer, 500);
    expect(pushes).toHaveLength(3);
    monitor.stop();
    monitor.start();
    expect(timer.getPendingIntervalCount()).toBe(0);
    monitor.startMonitoring(deviceA, "Playground", "ios");
    expect(timer.getPendingIntervalCount()).toBe(1);
  });

  for (const cleanup of ["release", "unbind"] as const) {
    test(`session ${cleanup} disarms the last device timer`, async () => {
      const { timer, monitor } = setup();
      const manager = new FakeSessionCleanupManager();
      registerPerformanceMonitorSessionCleanup(manager, { monitor: () => monitor });
      monitor.start();
      monitor.startMonitoring(deviceA, "Playground", "ios");
      manager[cleanup]("session", deviceA);
      await advanceTime(timer, 60000);
      expect(timer.wakeups).toBe(0);
      expect(timer.getPendingIntervalCount()).toBe(0);
    });
  }

  test("two iOS devices share 30 ps snapshots per minute while preserving every sample tier", async () => {
    const { timer, exec, monitor, pushes, buffer } = setup();
    monitor.start();
    monitor.startMonitoring(deviceA, "launchd_sim", "ios");
    monitor.startMonitoring(deviceB, "launchd_sim", "ios");
    await advanceTime(timer, 60000);
    console.log(`ps spawns / simulated minute, two iOS devices: ${exec.calls.length}`);
    expect(exec.calls).toHaveLength(30);
    expect(
      exec.calls.every(
        ({ file, args }) => file === "ps" && args.join() === PS_SNAPSHOT_ARGS.join(),
      ),
    ).toBe(true);
    for (const [deviceId, cpu, rssKb] of [
      [deviceA, 38.5, 410112],
      [deviceB, 20, 380000],
    ] as const) {
      const samples = buffer.recorded
        .filter((row) => row.deviceId === deviceId)
        .map((row) => row.sample);
      expect(samples).toHaveLength(120);
      expect(
        samples.filter((sample) => sample.cpuUsagePercent !== null).map((sample) => sample.t),
      ).toEqual(Array.from({ length: 30 }, (_, i) => 500 + i * 2000));
      expect(
        samples.filter((sample) => sample.memoryUsageMb !== null).map((sample) => sample.t),
      ).toEqual(Array.from({ length: 6 }, (_, i) => 500 + i * 10000));
      expect(pushes.filter((data) => data.deviceId === deviceId)).toHaveLength(120);
      expect(pushes.find((data) => data.deviceId === deviceId)?.metrics).toMatchObject({
        cpuUsagePercent: cpu,
        memoryUsageMb: rssKb / 1024,
      });
      expect(buffer.snapshot(deviceId, timer.now(), 60000).sampleCount).toBe(120);
    }
  });

  test("fresh snapshots re-resolve vanished, reused and restarted PIDs, cap CPU and retain memory cadence", async () => {
    const { timer, exec, monitor, pushes } = setup();
    monitor.start();
    monitor.startMonitoring(deviceA, "Playground", "ios");
    await advanceTime(timer, 500);
    expect(monitor.getMonitoredDevice(deviceA)?.cachedPid).toBe(90012);
    // Same PID now belongs to another app: identity must be checked on every snapshot.
    exec.stdout = capture.replaceAll("Playground", "OtherApp");
    await advanceTime(timer, 2000);
    expect(pushes.at(-1)?.metrics.cpuUsagePercent).toBeNull();
    expect(monitor.getMonitoredDevice(deviceA)?.cachedPid).toBeNull();
    exec.stdout = capture.replace("90012 90011 150000   1.2", "99012 90011 150000   123.4");
    await advanceTime(timer, 2000);
    expect(monitor.getMonitoredDevice(deviceA)?.cachedPid).toBe(99012);
    expect(pushes.at(-1)?.metrics).toMatchObject({
      cpuUsagePercent: 100,
      memoryUsageMb: 150000 / 1024,
    });
    exec.stdout = "";
    await advanceTime(timer, 6000);
    expect(pushes.at(-1)?.metrics).toMatchObject({ cpuUsagePercent: null, memoryUsageMb: null });
    exec.stdout = capture;
    await advanceTime(timer, 10000);
    expect(pushes.at(-1)?.metrics).toMatchObject({
      cpuUsagePercent: 1.2,
      memoryUsageMb: 150000 / 1024,
    });
    expect(monitor.getMonitoredDevice(deviceA)?.cachedPid).toBe(90012);
    expect(exec.calls).toHaveLength(11);
  });

  test("a failed shared snapshot yields null metrics and retries only on the next due tick", async () => {
    const { timer, exec, monitor, pushes } = setup();
    monitor.start();
    monitor.startMonitoring(deviceA, "Playground", "ios");
    monitor.startMonitoring(deviceB, "launchd_sim", "ios");
    exec.error = new Error("fake ps failed");
    await advanceTime(timer, 500);
    expect(exec.calls).toHaveLength(1);
    expect(pushes.map((data) => data.metrics.cpuUsagePercent)).toEqual([null, null]);
    expect(pushes.map((data) => data.metrics.memoryUsageMb)).toEqual([null, null]);
    exec.error = null;
    await advanceTime(timer, 1500);
    expect(exec.calls).toHaveLength(1);
    await advanceTime(timer, 500);
    expect(exec.calls).toHaveLength(2);
    expect(pushes.at(-2)?.metrics.cpuUsagePercent).toBe(1.2);
    expect(pushes.at(-1)?.metrics.cpuUsagePercent).toBe(20);
    // Memory's failed first sample is retried at its original slow cadence.
    expect(pushes.at(-1)?.metrics.memoryUsageMb).toBeNull();
  });

  test("nested pauses and incarnation reset keep registrations and timer semantics", async () => {
    const { timer, exec, monitor, pushes } = setup();
    monitor.start();
    monitor.startMonitoring(deviceA, "Playground", "ios");
    await monitor.withDeviceSamplingPaused(deviceA, async () => {
      await monitor.withDeviceSamplingPaused(deviceA, async () => {
        monitor.resetDeviceState(deviceA);
        await advanceTime(timer, 500);
      });
      await advanceTime(timer, 500);
      expect(pushes).toHaveLength(0);
      expect(exec.calls).toHaveLength(0);
      expect(timer.getPendingIntervalCount()).toBe(1);
    });
    await advanceTime(timer, 500);
    expect(pushes).toHaveLength(1);
    expect(exec.calls).toHaveLength(1);
    expect(monitor.isMonitoring(deviceA)).toBe(true);
  });
});
