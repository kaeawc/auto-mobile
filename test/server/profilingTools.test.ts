import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { ProfilingRegistry } from "../../src/features/profiling/ProfilingRegistry";
import { createHeapDumpHandler, heapDumpSchema } from "../../src/server/profilingTools";
import { heapDumpResultSchema } from "../../src/server/profilingToolOutputSchemas";
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
  return { device, registry, heap: createHeapDumpHandler(deps) };
}

function structured(response: unknown): Record<string, unknown> {
  return (response as { structuredContent: Record<string, unknown> }).structuredContent;
}

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
