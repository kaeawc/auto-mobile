import { describe, expect, spyOn, test } from "bun:test";
import {
  PerformanceMonitor,
  type PerformanceTelemetryEmitter,
} from "../../../src/features/performance/PerformanceMonitor";
import { PerfWindowBuffer } from "../../../src/features/performance/PerfWindowBuffer";
import { SdkFrameMetricsStore } from "../../../src/features/performance/SdkFrameMetricsStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

type TelemetryMetrics = Parameters<PerformanceMonitor["emitPerformanceTelemetry"]>[2];
const empty: TelemetryMetrics = {
  fps: null,
  frameTimeMs: null,
  jankFrames: null,
  touchLatencyMs: null,
  memoryUsageMb: null,
  cpuUsagePercent: null,
};

function makeMonitor() {
  const order: string[] = [];
  const events: Parameters<PerformanceTelemetryEmitter["recordPerformanceEvent"]>[0][] = [];
  const emitter: PerformanceTelemetryEmitter = {
    setContext: (deviceId, sessionId) => {
      order.push(`context:${deviceId}:${sessionId}`);
    },
    recordPerformanceEvent: (event) => {
      order.push("event");
      events.push(event);
    },
  };
  const frames = new SdkFrameMetricsStore();
  const buffer = new PerfWindowBuffer();
  const monitor = new PerformanceMonitor(
    new FakeTimer(),
    new FakeAdbClientFactory(),
    () => null,
    undefined,
    undefined,
    () => emitter,
    buffer,
    frames,
  );
  monitor.startMonitoring("fake-device", "com.fake");
  const device = monitor["monitoredDevices"].get("fake-device")!;
  return { monitor, device, events, order, frames, buffer };
}

describe("PerformanceMonitor telemetry health boundaries", () => {
  const rows = [
    {
      field: "fps",
      metric: "fps",
      values: [60, 55, 54, 45, 44],
      health: ["healthy", "healthy", "warning", "warning", "critical"],
    },
    {
      field: "frameTimeMs",
      metric: "frameTime",
      values: [0, 18, 19, 33, 34],
      health: ["healthy", "healthy", "warning", "warning", "critical"],
    },
    {
      field: "jankFrames",
      metric: "jank",
      values: [0, 5, 6, 10, 11],
      health: ["healthy", "healthy", "warning", "warning", "critical"],
    },
    {
      field: "touchLatencyMs",
      metric: "touchLatency",
      values: [0, 100, 101, 200, 201],
      health: ["healthy", "healthy", "warning", "warning", "critical"],
    },
    {
      field: "memoryUsageMb",
      metric: "memory",
      values: [0, 200, 201, 300, 301],
      health: ["healthy", "healthy", "warning", "warning", "critical"],
    },
  ] as const;
  for (const { field, metric, values, health } of rows) {
    test(`${metric} equality and crossing`, () => {
      const { monitor, device, events, order } = makeMonitor();
      monitor["emitPerformanceTelemetry"](device, 0, empty, "healthy");
      expect(events).toEqual([]);
      for (const [i, value] of values.entries()) {
        monitor["emitPerformanceTelemetry"](device, i + 1, { ...empty, [field]: value }, "overall");
        expect(device.previousMetricHealth).toEqual({ [metric]: health[i] });
      }
      expect(events.map((event) => event.changedMetrics)).toEqual([[metric], [metric], [metric]]);
      expect(order).toEqual(Array(3).fill(["context:fake-device:null", "event"]).flat());
    });
  }
  test("preserves key order, ignores new non-baseline metrics, and silently removes absent metrics", () => {
    const { monitor, device, events } = makeMonitor();
    const metrics = {
      fps: 60,
      frameTimeMs: 0,
      jankFrames: 0,
      touchLatencyMs: 0,
      memoryUsageMb: 0,
      cpuUsagePercent: 100,
    };
    monitor["emitPerformanceTelemetry"](device, 10, metrics, "healthy");
    expect(events[0]).toEqual({
      timestamp: 10,
      packageName: "com.fake",
      ...metrics,
      health: "healthy",
      changedMetrics: ["fps", "frameTime", "jank", "touchLatency", "memory"],
    });
    monitor["emitPerformanceTelemetry"](device, 11, { ...empty, fps: 60 }, "healthy");
    monitor["emitPerformanceTelemetry"](device, 12, metrics, "healthy");
    expect(events).toHaveLength(1);
    expect(device.previousMetricHealth).toEqual({
      fps: "healthy",
      frameTime: "healthy",
      jank: "healthy",
      touchLatency: "healthy",
      memory: "healthy",
    });
    monitor["emitPerformanceTelemetry"](
      device,
      13,
      {
        ...metrics,
        fps: 44,
        frameTimeMs: 34,
        jankFrames: 11,
        touchLatencyMs: 201,
        memoryUsageMb: 301,
      },
      "critical",
    );
    expect(events[1].changedMetrics).toEqual([
      "fps",
      "frameTime",
      "jank",
      "touchLatency",
      "memory",
    ]);
  });
});

describe("PerformanceMonitor Android parsed metric assembly", () => {
  for (const value of [null, 0]) {
    test(`SDK value ${value} preserves cache and raw window distinction`, async () => {
      const { monitor, device, frames, buffer } = makeMonitor();
      device.cachedFps = 60;
      device.cachedFrameTime = 16;
      frames.ingest("fake-device", "com.fake", {
        fps: value,
        frameTimeMs: value,
        jankFrames: 0,
        receivedAt: 500,
      });
      const internals = monitor as unknown as {
        collectGfxMetrics: PerformanceMonitor["collectGfxMetrics"];
        collectCpuMetrics: PerformanceMonitor["collectCpuMetrics"];
        collectMemoryMetrics: PerformanceMonitor["collectMemoryMetrics"];
      };
      const gfx = spyOn(internals, "collectGfxMetrics");
      const cpu = spyOn(internals, "collectCpuMetrics").mockResolvedValue({
        cpuUsagePercent: 0,
        sample: { processTicks: 0, uptimeSeconds: 1 },
      });
      const mem = spyOn(internals, "collectMemoryMetrics").mockResolvedValue({
        totalPssMb: 0,
        breakdown: null,
      });
      const pushed: Parameters<PerformanceMonitor["pushMetrics"]>[2][] = [];
      try {
        await monitor["sampleAndroidDevice"](
          device,
          500,
          {
            pushPerformanceData: (data) => {
              pushed.push(data.metrics);
            },
          },
          new AbortController().signal,
        );
        expect(gfx).not.toHaveBeenCalled();
        expect(pushed[0]).toMatchObject({
          fps: value ?? 60,
          frameTimeMs: value ?? 16,
          jankFrames: 0,
          touchLatencyMs: 16,
          cpuUsagePercent: 0,
          memoryUsageMb: 0,
        });
        expect(device.cachedFps).toBe(value ?? 60);
        expect(device.cachedFrameTime).toBe(value ?? 16);
        expect(device.previousCpuSample).toEqual({ processTicks: 0, uptimeSeconds: 1 });
        const snapshot = buffer.snapshot("fake-device", 500, 1000);
        expect(snapshot.fps?.p50 ?? null).toBe(value);
        expect(snapshot.touchLatencyMs).toBeNull();
      } finally {
        gfx.mockRestore();
        cpu.mockRestore();
        mem.mockRestore();
      }
    });
  }
});
