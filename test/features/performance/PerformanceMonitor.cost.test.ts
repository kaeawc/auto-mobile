import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { registerPerformanceMonitorSessionCleanup } from "../../../src/daemon/performanceMonitorSessionCleanup";
import type { LivePerformanceData } from "../../../src/daemon/streams/performancePushSocketServer";
import { PS_SNAPSHOT_ARGS } from "../../../src/devices/bootAdmission/psSnapshot";
import { PerformanceMonitor } from "../../../src/features/performance/PerformanceMonitor";
import {
  PerfWindowBuffer,
  type PerfSample,
} from "../../../src/features/performance/PerfWindowBuffer";
import { SdkFrameMetricsStore } from "../../../src/features/performance/SdkFrameMetricsStore";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSessionCleanupManager } from "../../fakes/FakeSessionCleanupManager";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";

const capture = readFileSync(
  new URL("../../fixtures/ios-sim-process-resolver/ps-rows.txt", import.meta.url),
  "utf8",
);
const launchctlCapture = readFileSync(
  new URL("../../fixtures/ios-sim-process-resolver/launchctl-list.txt", import.meta.url),
  "utf8",
);
const bundleId = "com.apple.Preferences";
const deviceA = "00547A72-3AAE-44FE-93DD-C6F46D071AE0";
const deviceB = "BCC31307-1A19-4D67-A7F0-44FC98F78921";
const secondAppRow = capture
  .split("\n")[1]
  .replace("97462 96106 486768   0.0", "97463 96107 380000  20.0");

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

class SnapshotExec {
  stdout = capture + secondAppRow;
  error: Error | null = null;
  readonly calls: { file: string; args: string[] }[] = [];
  execute = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    this.calls.push({ file, args });
    if (this.error) {
      throw this.error;
    }
    return { stdout: this.stdout, stderr: "" };
  };
}

const monitors: PerformanceMonitor[] = [];
function setup() {
  const timer = new CountingTimer();
  const exec = new SnapshotExec();
  const buffer = new RecordingBuffer();
  const simCtl = new FakeSimctl();
  const setLaunchctl = (deviceId: string, stdout: string) =>
    simCtl.setCommandArgsResult(["spawn", deviceId, "launchctl", "list"], stdout);
  setLaunchctl(deviceA, launchctlCapture);
  setLaunchctl(deviceB, launchctlCapture.replace("97462\t", "97463\t"));
  const pushes: LivePerformanceData[] = [];
  const monitor = new PerformanceMonitor(timer, {
    adbClientFactory: new FakeAdbClientFactory(),
    execFileAsync: exec.execute,
    simCtlClientFactory: { create: () => simCtl },
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
  return { timer, exec, buffer, pushes, monitor, setLaunchctl, simCtl };
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
    monitor.startMonitoring(deviceA, bundleId, "ios");
    expect(timer.getPendingIntervalCount()).toBe(1);
    monitor.start();
    monitor.start();
    monitor.startMonitoring(deviceB, bundleId, "ios");
    monitor.startMonitoring(deviceA, bundleId, "ios");
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
    monitor.startMonitoring(deviceA, bundleId, "ios");
    await advanceTime(timer, 500);
    expect(pushes).toHaveLength(3);
    monitor.stop();
    monitor.start();
    expect(timer.getPendingIntervalCount()).toBe(0);
    monitor.startMonitoring(deviceA, bundleId, "ios");
    expect(timer.getPendingIntervalCount()).toBe(1);
  });

  for (const cleanup of ["release", "unbind"] as const) {
    test(`session ${cleanup} disarms the last device timer`, async () => {
      const { timer, monitor } = setup();
      const manager = new FakeSessionCleanupManager();
      registerPerformanceMonitorSessionCleanup(manager, { monitor: () => monitor });
      monitor.start();
      monitor.startMonitoring(deviceA, bundleId, "ios");
      manager[cleanup]("session", deviceA);
      await advanceTime(timer, 60000);
      expect(timer.wakeups).toBe(0);
      expect(timer.getPendingIntervalCount()).toBe(0);
    });
  }

  test("two iOS devices share 30 ps snapshots per minute while preserving every sample tier", async () => {
    const { timer, exec, monitor, pushes, buffer, simCtl } = setup();
    monitor.start();
    monitor.startMonitoring(deviceA, bundleId, "ios");
    monitor.startMonitoring(deviceB, bundleId, "ios");
    await advanceTime(timer, 60000);
    console.log(`ps spawns / simulated minute, two iOS devices: ${exec.calls.length}`);
    expect(exec.calls).toHaveLength(30);
    expect(simCtl.getMethodCallCount("executeCommandArgs")).toBe(60);
    expect(
      exec.calls.every(
        ({ file, args }) => file === "ps" && args.join() === PS_SNAPSHOT_ARGS.join(),
      ),
    ).toBe(true);
    for (const [deviceId, cpu, rssKb] of [
      [deviceA, 0, 486768],
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
    const { timer, exec, monitor, pushes, setLaunchctl } = setup();
    monitor.start();
    monitor.startMonitoring(deviceA, bundleId, "ios");
    await advanceTime(timer, 500);
    expect(monitor.getMonitoredDevice(deviceA)?.cachedPid).toBe(97462);
    // Launchctl reports that a different app now owns the old PID.
    setLaunchctl(deviceA, launchctlCapture.replace(bundleId + "[", "com.example.other["));
    await advanceTime(timer, 2000);
    expect(pushes.at(-1)?.metrics.cpuUsagePercent).toBeNull();
    expect(monitor.getMonitoredDevice(deviceA)?.cachedPid).toBeNull();
    setLaunchctl(deviceA, launchctlCapture.replace("97462\t", "97464\t"));
    exec.stdout = capture.replace("97462 96106 486768   0.0", "97464 96106 486768 123.4");
    await advanceTime(timer, 2000);
    expect(monitor.getMonitoredDevice(deviceA)?.cachedPid).toBe(97464);
    expect(pushes.at(-1)?.metrics).toMatchObject({
      cpuUsagePercent: 100,
      memoryUsageMb: 486768 / 1024,
    });
    exec.stdout = "";
    await advanceTime(timer, 6000);
    expect(pushes.at(-1)?.metrics).toMatchObject({ cpuUsagePercent: null, memoryUsageMb: null });
    setLaunchctl(deviceA, launchctlCapture);
    exec.stdout = capture;
    await advanceTime(timer, 10000);
    expect(pushes.at(-1)?.metrics).toMatchObject({
      cpuUsagePercent: 0,
      memoryUsageMb: 486768 / 1024,
    });
    expect(monitor.getMonitoredDevice(deviceA)?.cachedPid).toBe(97462);
    expect(exec.calls).toHaveLength(10);
  });

  test("a failed shared snapshot yields null metrics and retries only on the next due tick", async () => {
    const { timer, exec, monitor, pushes } = setup();
    monitor.start();
    monitor.startMonitoring(deviceA, bundleId, "ios");
    monitor.startMonitoring(deviceB, bundleId, "ios");
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
    expect(pushes.at(-2)?.metrics.cpuUsagePercent).toBe(0);
    expect(pushes.at(-1)?.metrics.cpuUsagePercent).toBe(20);
    // Memory's failed first sample is retried at its original slow cadence.
    expect(pushes.at(-1)?.metrics.memoryUsageMb).toBeNull();
  });

  test("nested pauses and incarnation reset keep registrations and timer semantics", async () => {
    const { timer, exec, monitor, pushes } = setup();
    monitor.start();
    monitor.startMonitoring(deviceA, bundleId, "ios");
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
