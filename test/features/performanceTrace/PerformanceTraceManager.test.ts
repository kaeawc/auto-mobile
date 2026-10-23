import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { PerformanceTraceManager } from "../../../src/features/performanceTrace/PerformanceTraceManager";
import type {
  PerformanceTraceRecorder,
  RecordingPerformanceTrace,
  StartPerformanceTraceRequest,
} from "../../../src/features/performanceTrace/PerformanceTraceRecorder";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

const pixel: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const tablet: BootedDevice = { deviceId: "emulator-5556", name: "Tablet", platform: "android" };

class FakeRecorder implements PerformanceTraceRecorder {
  readonly started: StartPerformanceTraceRequest[] = [];
  readonly stops: string[] = [];
  stopError?: Error;
  summaryGate?: Promise<void>;

  async start(request: StartPerformanceTraceRequest): Promise<RecordingPerformanceTrace> {
    this.started.push(request);
    return {
      artifactPath: `${request.artifactDir}/${request.traceId}.perfetto-trace`,
      warnings: ["start warning"],
      stop: async () => {
        this.stops.push(request.traceId);
        if (this.stopError) {
          throw this.stopError;
        }
      },
      summarize: async () => {
        await this.summaryGate;
        return { summary: { durationMs: 1_500 }, warnings: ["summary warning"] };
      },
    };
  }
}

function manager() {
  const recorder = new FakeRecorder();
  const timer = new FakeTimer();
  timer.setCurrentTime(Date.parse("2026-10-21T10:00:00Z"));
  return {
    recorder,
    manager: new PerformanceTraceManager({
      recorderFor: () => recorder,
      artifactDir: async () => "/artifacts",
      idGenerator: new CountingIdGenerator("t"),
      timer,
    }),
  };
}

const hitches = { template: "hitches" as const, appId: "com.example.app", timeLimitMs: 10_000 };

describe("PerformanceTraceManager (#14102)", () => {
  test("start returns a recording trace and stop returns the bounded summary", async () => {
    const { manager: traces, recorder } = manager();

    const started = await traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });
    expect(started).toEqual({
      traceId: "trace-t-1",
      state: "recording",
      deviceId: "emulator-5554",
      platform: "android",
      template: "hitches",
      appId: "com.example.app",
      startedAt: "2026-10-21T10:00:00.000Z",
      timeLimitMs: 10_000,
      artifactPath: "/artifacts/trace-t-1.perfetto-trace",
      warnings: ["start warning"],
    });
    expect(recorder.started[0]).toMatchObject({ artifactDir: "/artifacts", timeLimitMs: 10_000 });

    const stopped = await traces.stop("trace-t-1");
    expect(stopped).toMatchObject({
      state: "stopped",
      summary: { durationMs: 1_500 },
      warnings: ["start warning", "summary warning"],
    });
    expect(await traces.stop("trace-t-1")).toBe(stopped);
    expect(recorder.stops).toEqual(["trace-t-1"]);
    expect(traces.activeTraceIds()).toEqual([]);
  });

  test("allows one recorder per device", async () => {
    const { manager: traces } = manager();
    await traces.start(pixel, hitches);
    await expect(traces.start(pixel, hitches)).rejects.toThrow(
      "already recording on emulator-5554",
    );
    await expect(traces.start(tablet, hitches)).resolves.toMatchObject({ traceId: "trace-t-2" });
  });

  test("concurrent stops share one teardown", async () => {
    const { manager: traces, recorder } = manager();
    await traces.start(pixel, hitches);
    const [first, second] = await Promise.all([traces.stop("trace-t-1"), traces.stop("trace-t-1")]);
    expect(first).toBe(second);
    expect(recorder.stops).toEqual(["trace-t-1"]);
  });

  test("releasing a session stops only the traces it owns", async () => {
    const { manager: traces, recorder } = manager();
    await traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });
    await traces.start(tablet, { ...hitches, ownerSessionUuid: "s2" });

    await traces.stopTracesForSession("s1");

    expect(recorder.stops).toEqual(["trace-t-1"]);
    expect(traces.activeTraceIds()).toEqual(["trace-t-2"]);
    expect(await traces.stop("trace-t-1")).toMatchObject({ state: "stopped" });
  });

  test("releasing a device stops its trace, and a failed stop still frees the device", async () => {
    const { manager: traces, recorder } = manager();
    recorder.stopError = new Error("adb: device offline");
    await traces.start(pixel, hitches);

    await traces.stopTracesOnDevice("emulator-5554");

    expect(recorder.stops).toEqual(["trace-t-1"]);
    expect(traces.activeTraceIds()).toEqual([]);
    await expect(traces.start(pixel, hitches)).resolves.toMatchObject({ traceId: "trace-t-2" });
  });

  test("stopping an unknown trace is an actionable error", async () => {
    await expect(manager().manager.stop("trace-missing")).rejects.toThrow(
      "No performance trace with id trace-missing",
    );
  });

  test("lookup keeps a stopped trace readable while its summary is generated", async () => {
    const { manager: traces, recorder } = manager();
    let release!: () => void;
    recorder.summaryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });
    expect(traces.lookup(started.traceId)?.result.state).toBe("recording");

    const stopping = traces.stop(started.traceId);
    await Promise.resolve();
    await Promise.resolve();

    const during = traces.lookup(started.traceId);
    expect(during?.ownerSessionUuid).toBe("s1");
    expect(during?.result.state).toBe("stopped");
    expect(during?.result.summary).toBeUndefined();
    expect(during?.result.warnings).toContain("The summary is still being generated.");

    release();
    await stopping;
    expect(traces.lookup(started.traceId)?.result.summary).toEqual({ durationMs: 1_500 });
  });
});
