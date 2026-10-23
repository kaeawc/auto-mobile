import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AndroidTraceCapture } from "../../../src/features/profiling/AndroidTraceCapture";
import { ProfilingRegistry } from "../../../src/features/profiling/ProfilingRegistry";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeProfilingDevice, FakeProfilingStore } from "../../fakes/FakeProfilingDevice";
import { FakeTimer } from "../../fakes/FakeTimer";

const DEVICE = "emulator-5554";
const APP = "dev.jasonpearson.automobile.playground";
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-profiling", name), "utf8");

function setup() {
  const device = new FakeProfilingDevice();
  device.perfettoStartOutput = fixture("perfetto-background-start.txt");
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  timer.setCurrentTime(1_000_000);
  const registry = new ProfilingRegistry();
  const store = new FakeProfilingStore(device);
  const capture = new AndroidTraceCapture({
    adb: device,
    timer,
    idGenerator: new FakeIdGenerator(["a1"]),
    registry,
    store,
  });
  return { device, timer, registry, store, capture };
}

describe("AndroidTraceCapture (#14113)", () => {
  test("start launches a detached recorder from the typed config and registers it", async () => {
    const { device, registry, capture } = setup();

    const started = await capture.start({
      deviceId: DEVICE,
      sessionId: "s-1",
      appId: APP,
      categories: ["view", "gfx"],
      maxDurationMs: 5000,
    });

    expect(started).toMatchObject({
      traceId: "trace-a1",
      startedAt: "1970-01-01T00:16:40.000Z",
      config: { categories: ["view", "gfx", "app"], bufferMb: 32, maxDurationMs: 5000 },
      warnings: [],
    });
    expect(device.commands[0]).toMatch(
      /^shell echo \S+ \| base64 -d \| perfetto --background --txt -c - -o \/data\/misc\/perfetto-traces\/automobile-trace-a1\.perfetto-trace$/,
    );
    expect(device.lastConfig).toContain(`atrace_apps: "${APP}"`);
    expect(device.lastConfig).toContain("duration_ms: 5000");
    expect(registry.getTrace("trace-a1")).toMatchObject({
      pid: 31337,
      sessionId: "s-1",
      deviceId: DEVICE,
    });
  });

  test("start without an appId warns that app tags are off", async () => {
    const { capture } = setup();
    const started = await capture.start({ deviceId: DEVICE });
    expect(started.warnings).toEqual(["No appId was given; app-scoped atrace tags are disabled."]);
  });

  test("stop signals the recorder, waits for the flush, pulls the file and removes the device copy", async () => {
    const { device, registry, store, capture, timer } = setup();
    await capture.start({ deviceId: DEVICE, maxDurationMs: 10_000 });
    const remote = "/data/misc/perfetto-traces/automobile-trace-a1.perfetto-trace";
    timer.advanceTime(4_000);

    const stopped = await capture.stop(DEVICE, "trace-a1");

    expect(stopped).toMatchObject({
      traceId: "trace-a1",
      path: "/host/outputs/1-captureTrace-trace-a1.perfetto-trace",
      sizeBytes: 4096,
    });
    expect(stopped.durationMs).toBeGreaterThanOrEqual(4_000);
    // One 250 ms flush poll elapses on the auto-advancing fake clock.
    expect(stopped.durationMs).toBe(4_250);
    expect(device.commands.filter((c) => c.startsWith("pull"))).toEqual([
      `pull ${remote} ${stopped.path}`,
    ]);
    expect(device.deviceFiles.has(remote)).toBe(false);
    expect(device.runningPids.size).toBe(0);
    expect(registry.getTrace("trace-a1")).toBeUndefined();
    expect(store.removed).toEqual([]);
  });

  test("a stop long after maxDurationMs reports the bounded duration", async () => {
    const { capture, timer } = setup();
    await capture.start({ deviceId: DEVICE, maxDurationMs: 2_000 });
    timer.advanceTime(60_000);
    expect((await capture.stop(DEVICE, "trace-a1")).durationMs).toBe(2_000);
  });

  test("concurrent stops share one teardown", async () => {
    const { device, capture } = setup();
    await capture.start({ deviceId: DEVICE });
    const [first, second] = await Promise.all([
      capture.stop(DEVICE, "trace-a1"),
      capture.stop(DEVICE, "trace-a1"),
    ]);
    expect(second).toBe(first);
    expect(device.commands.filter((c) => c.startsWith("pull"))).toHaveLength(1);
  });

  test("only one trace records per device and unknown ids are refused", async () => {
    const { capture } = setup();
    await capture.start({ deviceId: DEVICE });
    await expect(capture.start({ deviceId: DEVICE })).rejects.toThrow(
      "already recording on emulator-5554",
    );
    await expect(capture.stop(DEVICE, "trace-nope")).rejects.toThrow("No captureTrace");
    await expect(capture.stop("emulator-5556", "trace-a1")).rejects.toThrow("No captureTrace");
  });

  test("a device without perfetto fails the start and registers nothing", async () => {
    const { device, registry, capture } = setup();
    device.perfettoStartOutput = fixture("perfetto-background-missing.txt");
    await expect(capture.start({ deviceId: DEVICE })).rejects.toThrow(
      "perfetto did not start on emulator-5554: perfetto: inaccessible or not found",
    );
    expect(registry.traceOnDevice(DEVICE)).toBeUndefined();
  });

  test("a failed pull frees the device, removes the device copy and the partial host file", async () => {
    const { device, registry, store, capture } = setup();
    await capture.start({ deviceId: DEVICE });
    device.failing.set("pull ", "adb: pull failed");

    await expect(capture.stop(DEVICE, "trace-a1")).rejects.toThrow("pull failed");

    expect(registry.traceOnDevice(DEVICE)).toBeUndefined();
    expect(device.deviceFiles.size).toBe(0);
    expect(store.removed).toEqual(["/host/outputs/1-captureTrace-trace-a1.perfetto-trace"]);
  });

  test("a trace that never fills fails with an empty-trace error and no device file is left", async () => {
    const { device, registry, capture } = setup();
    device.traceBytes = 0;
    await capture.start({ deviceId: DEVICE });
    await expect(capture.stop(DEVICE, "trace-a1")).rejects.toThrow("trace is empty");
    expect(device.deviceFiles.size).toBe(0);
    expect(registry.traceOnDevice(DEVICE)).toBeUndefined();
  });

  test("a SIGTERM that cannot be dispatched leaves the trace registered and retryable (#14113 review)", async () => {
    const { device, registry, capture } = setup();
    await capture.start({ deviceId: DEVICE, sessionId: "s-1" });
    device.failing.set("kill -TERM", "adb dispatch aborted");

    await expect(capture.stop(DEVICE, "trace-a1")).rejects.toThrow("adb dispatch aborted");

    expect(device.runningPids.size).toBe(1);
    expect(registry.getTrace("trace-a1")).toBeDefined();
    expect(device.deviceFiles.size).toBe(1);

    device.failing.clear();
    const stopped = await capture.stop(DEVICE, "trace-a1");
    expect(stopped.sizeBytes).toBe(4096);
    expect(device.runningPids.size).toBe(0);
    expect(registry.getTrace("trace-a1")).toBeUndefined();
  });

  test("session-release cleanup can still stop a recorder whose stop failed", async () => {
    const { device, registry, capture } = setup();
    await capture.start({ deviceId: DEVICE, sessionId: "s-1" });
    device.failing.set("kill -TERM", "adb dispatch aborted");
    await expect(capture.stop(DEVICE, "trace-a1")).rejects.toThrow();
    expect(registry.takeOwnedBy(DEVICE, "s-1").traces.map((t) => t.traceId)).toEqual(["trace-a1"]);
  });
});
