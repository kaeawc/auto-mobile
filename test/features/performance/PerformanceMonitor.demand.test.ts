import { afterEach, describe, expect, test } from "bun:test";
import { createDaemonPerformanceDemandProbe } from "../../../src/features/performance/PerformanceDemandProbe";
import type { PerformanceDemandProbe } from "../../../src/features/performance/PerformanceMonitorTypes";
import type { LivePerformanceData } from "../../../src/daemon/performancePushSocketServer";
import { PerformanceMonitor } from "../../../src/features/performance/PerformanceMonitor";
import {
  PerfWindowBuffer,
  type PerfSample,
} from "../../../src/features/performance/PerfWindowBuffer";
import { SdkFrameMetricsStore } from "../../../src/features/performance/SdkFrameMetricsStore";
import { TelemetryPushSocketServer } from "../../../src/daemon/telemetryPushSocketServer";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSocket } from "../../fakes/FakeNetServer";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";

/** A real telemetry server whose sole performance subscriber is mid-backfill. */
class BackfillingTelemetryServer extends TelemetryPushSocketServer {
  readonly socket = new FakeSocket();
  constructor(timer: FakeTimer) {
    super("/fake/telemetry-demand.sock", timer);
  }
  beginBackfill(): void {
    this.subscribers.set("perf", {
      socket: this.socket,
      subscriptionId: "perf",
      lastActivity: 0,
      filter: { category: "performance", deviceSessionUuid: null, deviceId: null, sessionId: null },
      backfilling: true,
      drainPending: false,
    });
    this.startBackfill("perf");
  }
  finish(): Promise<void> {
    return this.finishBackfill("perf");
  }
}

class RecordingBuffer extends PerfWindowBuffer {
  readonly records: PerfSample[] = [];
  override record(deviceId: string, sample: PerfSample): void {
    this.records.push(sample);
    super.record(deviceId, sample);
  }
}

const monitors: PerformanceMonitor[] = [];
function setup(demandProbe?: PerformanceDemandProbe) {
  const timer = new FakeTimer();
  const adb = new FakeAdbClientFactory();
  const buffer = new RecordingBuffer();
  const frames = new SdkFrameMetricsStore();
  const demanded = new Set<string>();
  const probes: string[] = [];
  const pushes: LivePerformanceData[] = [];
  const ps: string[] = [];
  const monitor = new PerformanceMonitor(timer, {
    adbClientFactory: adb,
    demandProbe: demandProbe ?? {
      hasDemand: (deviceId, _packageName, _platform) => {
        probes.push(deviceId);
        return demanded.has(deviceId);
      },
    },
    execFileAsync: async (file) => {
      ps.push(file);
      return { stdout: "", stderr: "" };
    },
    serverGetter: () => ({
      pushPerformanceData: (data) => {
        pushes.push(data);
      },
    }),
    perfWindowBuffer: buffer,
    frameMetricsStore: frames,
    getTelemetryEmitter: () => ({ setContext: () => {}, recordPerformanceEvent: () => {} }),
  });
  monitors.push(monitor);
  // Immediate fakes need only the sampler await chain drained between ticks.
  const advance = (ms: number) =>
    timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer, { quietTurns: 32 }));
  const registerFleet = () => {
    monitor.startMonitoring("android-a", "com.a", "android");
    monitor.startMonitoring("android-b", "com.b", "android");
    monitor.startMonitoring("ios-a", "com.c", "ios");
  };
  return {
    timer,
    adb,
    buffer,
    frames,
    demanded,
    probes,
    pushes,
    ps,
    monitor,
    advance,
    registerFleet,
  };
}

afterEach(() => {
  for (const monitor of monitors) {
    monitor.stop();
  }
  monitors.length = 0;
});

describe("PerformanceMonitor demand", () => {
  test("device-stream demand samples Android while leaving iOS dormant", async () => {
    const streamChecks: string[] = [];
    const probe = createDaemonPerformanceDemandProbe({
      getPerformancePushServer: () => null,
      getTelemetryPushServer: () => null,
      getDeviceDataStreamServer: () => ({
        hasSubscriberForDevice: (deviceId) => {
          streamChecks.push(deviceId);
          return true;
        },
      }),
    });
    const { monitor, advance, pushes, ps } = setup(probe);
    monitor.startMonitoring("android-a", "com.a", "android");
    monitor.startMonitoring("ios-a", "com.c", "ios");
    await advance(1000);
    expect(streamChecks).toEqual(["android-a", "android-a"]);
    expect(pushes).toHaveLength(2);
    expect(pushes.every(({ deviceId }) => deviceId === "android-a")).toBe(true);
    expect(ps).toHaveLength(0);
  });

  test("a telemetry subscriber mid-backfill keeps the device sampling across ticks (#14461)", async () => {
    const telemetry = new BackfillingTelemetryServer(new FakeTimer());
    const probe = createDaemonPerformanceDemandProbe({
      getPerformancePushServer: () => null,
      getDeviceDataStreamServer: () => null,
      getTelemetryPushServer: () => telemetry,
    });
    const { monitor, advance, pushes } = setup(probe);
    monitor.startMonitoring("ios-a", "com.c", "ios");
    telemetry.beginBackfill();
    // Two sampling ticks land while the subscription's DB backfill is in flight.
    await advance(1000);
    expect(pushes).toHaveLength(2);
    await telemetry.finish();
    await advance(500);
    expect(pushes).toHaveLength(3);
    telemetry.socket.destroy();
    await advance(500);
    expect(pushes).toHaveLength(3);
  });

  test("no consumers: zero subprocesses, pushes or buffer records for a minute", async () => {
    const { adb, buffer, pushes, ps, probes, advance, registerFleet } = setup();
    registerFleet();
    await advance(60000);
    console.log(
      `no demand / minute: before=312 adb/30 ps; after=${adb.getFakeClient().getInteractionLog().length} adb/${ps.length} ps/${pushes.length} pushes/${buffer.records.length} records`,
    );
    expect(adb.getFakeClient().getInteractionLog()).toHaveLength(0);
    expect(ps).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(buffer.records).toHaveLength(0);
    expect(probes).toHaveLength(3 * 120);
  });

  test("only the demanded Android device runs, retaining its 156 adb/minute baseline", async () => {
    const { adb, demanded, pushes, ps, advance, registerFleet } = setup();
    registerFleet();
    demanded.add("android-a");
    await advance(60000);
    console.log(
      `one Android demand / minute: ${adb.getFakeClient().getInteractionLog().length} adb/${ps.length} ps`,
    );
    expect(adb.getFakeClient().getInteractionLog()).toHaveLength(156);
    expect(adb.getCalls().every(({ device }) => device?.deviceId === "android-a")).toBe(true);
    expect(ps).toHaveLength(0);
    expect(pushes).toHaveLength(120);
    expect(pushes.every(({ deviceId }) => deviceId === "android-a")).toBe(true);
  });

  for (const iosCount of [1, 2]) {
    test(`all demand retains 312 adb and shared 30 ps/minute with ${iosCount} iOS devices`, async () => {
      const { adb, demanded, pushes, ps, advance, registerFleet, monitor } = setup();
      registerFleet();
      for (const id of ["android-a", "android-b", "ios-a"]) {
        demanded.add(id);
      }
      if (iosCount === 2) {
        monitor.startMonitoring("ios-b", "com.d", "ios");
        demanded.add("ios-b");
      }
      await advance(60000);
      console.log(
        `all demand (${iosCount} iOS) / minute: ${adb.getFakeClient().getInteractionLog().length} adb/${ps.length} ps`,
      );
      expect(adb.getFakeClient().getInteractionLog()).toHaveLength(312);
      expect(ps).toHaveLength(30);
      expect(pushes).toHaveLength((2 + iosCount) * 120);
    });
  }

  test("demand gaps reset baselines in place and re-prime gfx without clearing SDK data or health", async () => {
    const { adb, buffer, frames, demanded, monitor, advance, timer } = setup();
    const client = adb.getFakeClient();
    client.setCommandResult(
      "shell dumpsys gfxinfo 'com.a' reset",
      "Total frames rendered: 100\n50th percentile: 8ms\nMissed Vsync: 2",
    );
    client.setCommandResult("shell dumpsys meminfo 'com.a'", "TOTAL PSS: 102400");
    monitor.startMonitoring("android-a", "com.a");
    demanded.add("android-a");
    await advance(1000);
    expect(buffer.records.at(-1)?.fps).not.toBeNull();
    const state = monitor.getMonitoredDevice("android-a")!;
    const generation = state.monitoringGeneration;
    const health = state.previousMetricHealth;
    Object.assign(state, {
      cachedPid: 42,
      cachedCpu: 90,
      cachedMemoryBreakdown: {
        javaHeap: 99,
        nativeHeap: null,
        code: null,
        stack: null,
        graphics: null,
        privateOther: null,
        system: null,
      },
      previousCpuSample: { processTicks: 500, uptimeSeconds: 1 },
    });
    demanded.clear();
    const before = client.getInteractionLog().length;
    const recordsBefore = buffer.records.length;
    await advance(500);
    expect(client.getInteractionLog()).toHaveLength(before);
    expect(buffer.records).toHaveLength(recordsBefore);
    demanded.add("android-a");
    await advance(500);
    expect(monitor.getMonitoredDevice("android-a")).toBe(state);
    expect(state.monitoringGeneration).toBe(generation);
    expect(state.previousMetricHealth).toEqual(health);
    expect(state.cachedPid).toBeNull();
    expect(state.previousCpuSample).toBeNull();
    expect(state.cachedMemoryBreakdown).toBeNull();
    expect(state.cachedCpu).toBeNull();
    expect(state.cachedMemory).toBe(100);
    expect(state.lastMediumTick).toBe(timer.now());
    expect(state.lastSlowTick).toBe(timer.now());
    expect(buffer.records.at(-1)).toMatchObject({
      fps: null,
      frameTimeMs: null,
      jankFrames: null,
      memoryUsageMb: 100,
    });
    expect(
      client
        .getInteractionLog()
        .slice(before)
        .map(({ text }) => text),
    ).toEqual([
      "shell dumpsys gfxinfo 'com.a' reset",
      "shell pidof 'com.a'",
      "shell dumpsys meminfo 'com.a'",
    ]);
    await advance(500);
    expect(buffer.records.at(-1)?.fps).not.toBeNull();
    // SDK ingest is independent: a fresh SDK frame survives another gap.
    demanded.clear();
    await advance(500);
    frames.ingest("android-a", "com.a", {
      fps: 55,
      frameTimeMs: 18,
      jankFrames: 1,
      receivedAt: timer.now(),
    });
    demanded.add("android-a");
    await advance(500);
    expect(buffer.records.at(-1)?.fps).toBe(55);
  });

  test("a perf window lease expires after five minutes and refresh extends it", async () => {
    const { monitor, advance, pushes, probes } = setup();
    monitor.requestPerfWindow("ios-a", "com.c", "ios");
    await advance(299500);
    expect(pushes).toHaveLength(599);
    await advance(500);
    expect(pushes).toHaveLength(599);
    monitor.requestPerfWindow("ios-a", "com.c", "ios");
    await advance(500);
    expect(pushes).toHaveLength(600);
    await advance(1000);
    monitor.requestPerfWindow("ios-a", "com.c", "ios");
    await advance(299000);
    const beforeExpiry = pushes.length;
    await advance(500);
    expect(pushes).toHaveLength(beforeExpiry + 1);
    await advance(500);
    expect(pushes).toHaveLength(beforeExpiry + 1);
    expect(probes.length).toBeGreaterThan(0);
  });

  test("stopMonitoring and stop clear leases; a fresh registration stays dormant", async () => {
    const { monitor, advance, pushes } = setup();
    monitor.requestPerfWindow("ios-a", "com.c", "ios");
    await advance(500);
    monitor.stopMonitoring("ios-a");
    monitor.startMonitoring("ios-a", "com.c", "ios");
    await advance(500);
    expect(pushes).toHaveLength(1);
    monitor.requestPerfWindow("ios-a", "com.c", "ios");
    monitor.stop();
    monitor.startMonitoring("ios-a", "com.c", "ios");
    await advance(500);
    expect(pushes).toHaveLength(1);
    expect(monitor.isMonitoring("ios-a")).toBe(true);
  });

  test("hierarchy-style registration stays monitored without doing work", async () => {
    const { monitor, advance, adb, ps, pushes, buffer, timer } = setup();
    monitor.startMonitoring("android-a", "com.a");
    monitor.startMonitoring("android-a", "com.a");
    await advance(5000);
    expect(monitor.isMonitoring("android-a")).toBe(true);
    expect(timer.getPendingIntervalCount()).toBe(1);
    expect(adb.getFakeClient().getInteractionLog()).toHaveLength(0);
    expect(ps).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(buffer.records).toHaveLength(0);
  });
});
