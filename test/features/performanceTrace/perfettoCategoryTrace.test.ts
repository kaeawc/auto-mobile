import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice } from "../../../src/models";
import {
  CATEGORY_TRACE_NO_SUMMARY_WARNING,
  PerfettoRecorder,
} from "../../../src/features/performanceTrace/PerfettoRecorder";
import {
  perfettoCategoryConfig,
  resolveTraceConfig,
} from "../../../src/features/performanceTrace/perfettoCategoryConfig";
import type { PerfettoTraceProcessor } from "../../../src/features/performanceTrace/perfettoTraceProcessor";
import { ProfilingRegistry } from "../../../src/features/profiling/ProfilingRegistry";
import { logger } from "../../../src/utils/logger";
import { FakeProfilingDevice } from "../../fakes/FakeProfilingDevice";
import { FakeTimer } from "../../fakes/FakeTimer";

const profiling = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-profiling", name), "utf8");

const android: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const REMOTE = "/data/misc/perfetto-traces/automobile-trace-1.perfetto-trace";

function setup(processor?: PerfettoTraceProcessor) {
  const device = new FakeProfilingDevice();
  device.perfettoStartOutput = profiling("perfetto-background-start.txt");
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const queries: string[] = [];
  const registry = new ProfilingRegistry();
  const removedHostFiles: string[] = [];
  const recorder = new PerfettoRecorder({
    adbFor: () => device,
    traceProcessor: async () =>
      processor && {
        query: async (path, sql, signal) => {
          queries.push(sql);
          return processor.query(path, sql, signal);
        },
      },
    timer,
    stopPollAttempts: 3,
    flushPollAttempts: 4,
    registry,
    removeHostFile: async (path) => {
      removedHostFiles.push(path);
      device.hostFiles.delete(path);
    },
  });
  return { device, recorder, queries, registry, removedHostFiles };
}

function categoryRequest(appId?: string) {
  const categoryConfig = resolveTraceConfig({
    categories: ["gfx", "binder_driver", "memory"],
    appId,
    bufferMb: 64,
    maxDurationMs: 12_000,
  });
  return {
    traceId: "trace-1",
    device: android,
    appId,
    timeLimitMs: 12_000,
    artifactDir: "/artifacts",
    ownerSessionUuid: "s-1",
    categoryConfig,
  };
}

/** Silence the expected removal-failure warning. */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    return await run();
  } finally {
    warn.mockRestore();
  }
}

describe("Perfetto recorder with categories (#18688)", () => {
  test("starts perfetto with exactly the category config, buffer size and time bound", async () => {
    const { device, recorder } = setup();
    const request = categoryRequest("com.example.app");

    await recorder.start(request);

    expect(device.lastConfig).toBe(perfettoCategoryConfig(request.categoryConfig));
    expect(device.lastConfig).toContain("buffers { size_kb: 65536 fill_policy: RING_BUFFER }");
    expect(device.lastConfig).toContain('atrace_categories: "binder_driver"');
    expect(device.lastConfig).toContain('atrace_apps: "com.example.app"');
    expect(device.lastConfig).toContain('name: "linux.sys_stats"');
    expect(device.lastConfig).toContain("duration_ms: 12000");
    expect(device.runningPids.size).toBe(1);
  });

  test("stop pulls the trace to the host artifact and removes the device copy", async () => {
    const { device, recorder } = setup();
    const recording = await recorder.start(categoryRequest("com.example.app"));

    await recording.stop();

    expect(recording.artifactPath).toBe(join("/artifacts", "automobile-trace-1.perfetto-trace"));
    expect(device.runningPids.size).toBe(0);
    expect(device.hostFiles.get(recording.artifactPath)).toBe(device.traceBytes);
    expect(device.deviceFiles.has(REMOTE)).toBe(false);
  });

  test("summarize returns an empty summary with a warning and runs no template query", async () => {
    const processor: PerfettoTraceProcessor = { query: async () => [{ dur: "2000000000" }] };
    const { recorder, queries } = setup(processor);
    const recording = await recorder.start(categoryRequest("com.example.app"));
    await recording.stop();

    expect(await recording.summarize()).toEqual({
      summary: {},
      warnings: [CATEGORY_TRACE_NO_SUMMARY_WARNING],
    });
    expect(queries).toEqual([]);
  });

  test("without an appId the app's atrace tags are off and the start says so", async () => {
    const { device, recorder } = setup();
    const recording = await recorder.start(categoryRequest());

    expect(device.lastConfig).not.toContain("atrace_apps");
    expect(recording.warnings).toEqual([
      "No appId was given; app-scoped atrace tags are disabled.",
    ]);
  });

  test("a failed pull removes the host partial and the device copy", async () => {
    const { device, recorder, registry, removedHostFiles } = setup();
    const recording = await recorder.start(categoryRequest("com.example.app"));
    device.failing.set("pull", "adb: device offline");

    await expect(recording.stop()).rejects.toThrow("device offline");

    expect(recording.signalled).toBe(true);
    expect(removedHostFiles).toEqual([recording.artifactPath]);
    expect(device.deviceFiles.has(REMOTE)).toBe(false);
    expect(registry.takeOwnedBy(android.deviceId, "s-1")).toEqual({ deviceFiles: [] });
  });

  test("a device copy that cannot be removed is left to the owning session's release", async () => {
    const { device, recorder, registry } = setup();
    const recording = await recorder.start(categoryRequest("com.example.app"));
    device.failing.set("pull", "adb: device offline");
    device.failing.set("rm -f", "adb: device offline");

    const error = await quietly(() =>
      recording.stop().then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    expect(error).toBeInstanceOf(Error);

    expect(registry.takeOwnedBy(android.deviceId, "s-1")).toEqual({
      deviceFiles: [{ deviceId: android.deviceId, sessionId: "s-1", remotePath: REMOTE }],
    });
  });

  test("an exit probe that fails after the SIGTERM still cleans up the host and device copies", async () => {
    const { device, recorder, registry, removedHostFiles } = setup();
    const recording = await recorder.start(categoryRequest("com.example.app"));
    device.failing.set("kill -0", "adb: device offline");

    await expect(recording.stop()).rejects.toThrow("device offline");

    expect(recording.signalled).toBe(true);
    expect(removedHostFiles).toEqual([recording.artifactPath]);
    expect(device.deviceFiles.has(REMOTE)).toBe(false);
    expect(registry.takeOwnedBy(android.deviceId, "s-1")).toEqual({ deviceFiles: [] });
  });

  test("a stop whose SIGTERM never reaches the device reports the recorder unsignalled", async () => {
    const { device, recorder, removedHostFiles } = setup();
    const recording = await recorder.start(categoryRequest("com.example.app"));
    device.failing.set("kill -TERM", "adb: device offline");

    await expect(recording.stop()).rejects.toThrow("device offline");

    expect(recording.signalled).toBe(false);
    expect(device.runningPids.size).toBe(1);
    expect(device.deviceFiles.has(REMOTE)).toBe(true);
    expect(removedHostFiles).toEqual([]);

    device.failing.delete("kill -TERM");
    await recording.stop();
    expect(recording.signalled).toBe(true);
    expect(device.hostFiles.get(recording.artifactPath)).toBe(device.traceBytes);
  });

  test("a device without perfetto fails the start", async () => {
    const { device, recorder } = setup();
    device.perfettoStartOutput = profiling("perfetto-background-missing.txt");

    await expect(recorder.start(categoryRequest())).rejects.toThrow("perfetto did not start");
  });
});
