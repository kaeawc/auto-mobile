import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { ProfilingRegistry } from "../../src/features/profiling/ProfilingRegistry";
import { createHeapDumpHandler, heapDumpSchema } from "../../src/server/profilingTools";
import { heapDumpResultSchema } from "../../src/server/profilingToolOutputSchemas";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeProfilingDevice, FakeProfilingStore } from "../fakes/FakeProfilingDevice";
import { FakeTimer } from "../fakes/FakeTimer";

const APP = "dev.jasonpearson.automobile.playground";
const android: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
const ios: BootedDevice = {
  name: "iPhone",
  deviceId: "11111111-2222-3333-4444-555555555555",
  platform: "ios",
};

function setup() {
  const device = new FakeProfilingDevice();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const registry = new ProfilingRegistry();
  const deps = {
    adbFor: () => device,
    iosHeapDump: { host: new FakeHostCommandExecutor(), resolvePid: async () => 9861 },
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
      format: "hprof",
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

  test("iOS Simulator returns a schema-valid memgraph for a bundle ID", async () => {
    const { heap, device } = setup();
    const args = heapDumpSchema.parse({ appId: "com.apple.Preferences", native: false });
    const path = "/host/outputs/1-heapDump-x1.memgraph";
    device.hostFiles.set(path, 4096);

    const result = structured(await heap(ios, args));

    expect(heapDumpResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ path, sizeBytes: 4096, format: "memgraph", pid: 9861 });
    expect(result).not.toHaveProperty("native");
    expect(result).not.toHaveProperty("attempts");
    expect(device.commands).toEqual([]);
  });

  test("tvOS is refused", async () => {
    const { heap } = setup();
    await expect(heap({ ...ios, platform: "tvos" }, { appId: APP })).rejects.toThrow(
      "only supported on Android or iOS",
    );
  });

  test("the schema rejects invalid appIds and extra inputs", () => {
    expect(heapDumpSchema.safeParse({ appId: "not a package" }).success).toBe(false);
    expect(heapDumpSchema.safeParse({ appId: APP, extra: 1 }).success).toBe(false);
  });

  test("accepts hyphens in iOS bundle IDs and retains Android package validation", async () => {
    const { heap, device } = setup();
    const args = heapDumpSchema.parse({ appId: "com.example.my-app" });
    await expect(heap(android, args)).rejects.toThrow("appId must be an Android package name");
    expect(device.commands).toEqual([]);
  });
});
