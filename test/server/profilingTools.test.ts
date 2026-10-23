import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { ProfilingRegistry } from "../../src/features/profiling/ProfilingRegistry";
import {
  captureTraceSchema,
  createCaptureTraceHandler,
  createHeapDumpHandler,
  heapDumpSchema,
} from "../../src/server/profilingTools";
import {
  captureTraceResultSchema,
  heapDumpResultSchema,
} from "../../src/server/profilingToolOutputSchemas";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeProfilingDevice, FakeProfilingStore } from "../fakes/FakeProfilingDevice";
import { FakeTimer } from "../fakes/FakeTimer";

const APP = "dev.jasonpearson.automobile.playground";
const android: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
const ios: BootedDevice = { name: "iPhone", deviceId: "sim-1", platform: "ios" };

function setup() {
  const device = new FakeProfilingDevice();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const registry = new ProfilingRegistry();
  const deps = {
    adbFor: () => device,
    timer,
    idGenerator: new FakeIdGenerator(["x1", "x2"]),
    registry,
    store: new FakeProfilingStore(device),
  };
  return {
    device,
    registry,
    trace: createCaptureTraceHandler(deps),
    heap: createHeapDumpHandler(deps),
  };
}

function structured(response: unknown): Record<string, unknown> {
  return (response as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe("captureTrace tool", () => {
  test("start then stop returns schema-valid results with a host path, never the bytes", async () => {
    const { trace } = setup();

    const started = structured(
      await trace(android, { action: "start", appId: APP, sessionUuid: "s-1" }),
    );
    expect(captureTraceResultSchema.safeParse(started).success).toBe(true);
    expect(started).toMatchObject({
      action: "start",
      traceId: "trace-x1",
      categories: ["sched", "gfx", "view", "app"],
      bufferMb: 32,
      maxDurationMs: 30_000,
    });
    expect(started.path).toBeUndefined();

    const stopped = structured(await trace(android, { action: "stop", traceId: "trace-x1" }));
    expect(captureTraceResultSchema.safeParse(stopped).success).toBe(true);
    expect(stopped).toMatchObject({
      action: "stop",
      traceId: "trace-x1",
      path: "/host/outputs/1-captureTrace-trace-x1.perfetto-trace",
      sizeBytes: 4096,
    });
    expect(JSON.stringify(stopped).length).toBeLessThan(1500);
  });

  test("stop without a traceId, and iOS, are refused", async () => {
    const { trace } = setup();
    await expect(trace(android, { action: "stop" })).rejects.toThrow("requires the traceId");
    await expect(trace(ios, { action: "start" })).rejects.toThrow("only supported on Android");
  });

  test("schema rejects raw config strings and out-of-range sizes, accepts typed categories", () => {
    const ok = { action: "start", categories: ["gfx", "binder_driver"], bufferMb: 64 };
    expect(captureTraceSchema.safeParse(ok).success).toBe(true);
    expect(captureTraceSchema.safeParse({ ...ok, config: "buffers {}" }).success).toBe(false);
    expect(captureTraceSchema.safeParse({ ...ok, categories: ["raw"] }).success).toBe(false);
    expect(captureTraceSchema.safeParse({ ...ok, categories: [] }).success).toBe(false);
    expect(captureTraceSchema.safeParse({ ...ok, bufferMb: 1000 }).success).toBe(false);
    expect(captureTraceSchema.safeParse({ ...ok, maxDurationMs: 1 }).success).toBe(false);
    expect(captureTraceSchema.safeParse({ ...ok, appId: "x; rm -rf /" }).success).toBe(false);
  });
});

describe("heapDump tool", () => {
  test("returns a schema-valid host path and size", async () => {
    const { heap } = setup();

    const result = structured(await heap(android, { appId: APP, native: true }));

    expect(heapDumpResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      path: "/host/outputs/1-heapDump-x1.hprof",
      sizeBytes: 8192,
      native: true,
      appId: APP,
    });
  });

  test("a non-debuggable app is refused with the typed error", async () => {
    const { heap, device } = setup();
    device.packageDump = "    pkgFlags=[ HAS_CODE ALLOW_BACKUP ]\n";
    await expect(heap(android, { appId: "com.example.release" })).rejects.toThrow(
      "heap_dump_not_debuggable",
    );
  });

  test("iOS is refused and the schema rejects a non-package appId", async () => {
    const { heap } = setup();
    await expect(heap(ios, { appId: APP })).rejects.toThrow("only supported on Android");
    expect(heapDumpSchema.safeParse({ appId: "not a package" }).success).toBe(false);
    expect(heapDumpSchema.safeParse({ appId: APP, extra: 1 }).success).toBe(false);
  });
});
