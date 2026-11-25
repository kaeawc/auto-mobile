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
  readonly discards: string[] = [];
  stopError?: Error;
  /** Fail the next stops before the recorder is signalled (adb gone before the SIGTERM). */
  unsignalledFailures = 0;
  summaryGate?: Promise<void>;
  summarizeStarted?: () => void;
  /** Hold `start` until released, to race a release against it. */
  startGate?: Promise<void>;

  async start(request: StartPerformanceTraceRequest): Promise<RecordingPerformanceTrace> {
    this.started.push(request);
    await this.startGate;
    let signalled = false;
    return {
      artifactPath: `${request.artifactDir}/${request.traceId}.perfetto-trace`,
      warnings: ["start warning"],
      get signalled() {
        return signalled;
      },
      stop: async () => {
        this.stops.push(request.traceId);
        if (this.unsignalledFailures > 0) {
          this.unsignalledFailures -= 1;
          throw new Error("adb: device offline before SIGTERM");
        }
        signalled = true;
        if (this.stopError) {
          throw this.stopError;
        }
      },
      discard: async () => {
        this.discards.push(request.traceId);
        signalled = true;
      },
      summarize: async () => {
        this.summarizeStarted?.();
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

    const summarizing = new Promise<void>((resolve) => {
      recorder.summarizeStarted = resolve;
    });
    const stopping = traces.stop(started.traceId);
    await summarizing;

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

const iphone: BootedDevice = { deviceId: "sim-1", name: "iPhone", platform: "ios" };

describe("PerformanceTraceManager categories (#18688)", () => {
  test("a categories start resolves the config, hands it to the recorder and echoes it", async () => {
    const { manager: traces, recorder } = manager();

    const started = await traces.start(pixel, {
      categories: ["gfx", "binder_driver"],
      bufferMb: 64,
      appId: "com.example.app",
      timeLimitMs: 10_000,
    });

    expect(recorder.started[0]?.template).toBeUndefined();
    expect(recorder.started[0]).toMatchObject({
      categoryConfig: {
        categories: ["gfx", "binder_driver", "app"],
        appId: "com.example.app",
        bufferMb: 64,
        maxDurationMs: 10_000,
      },
    });
    expect(started).toMatchObject({ categories: ["gfx", "binder_driver", "app"], bufferMb: 64 });
    expect(started.template).toBeUndefined();
  });

  test("a template start carries no categories", async () => {
    const { manager: traces } = manager();
    const started = await traces.start(pixel, hitches);
    expect(started.categories).toBeUndefined();
    expect(started.bufferMb).toBeUndefined();
  });

  test("categories on iOS are refused before any recorder runs", async () => {
    const { manager: traces, recorder } = manager();
    await expect(
      traces.start(iphone, { categories: ["sched"], timeLimitMs: 10_000 }),
    ).rejects.toThrow("categories are Android (Perfetto) only");
    expect(recorder.started).toEqual([]);
  });

  test("refuses both or neither shape, bufferMb with a template, and app without an appId", async () => {
    const { manager: traces, recorder } = manager();
    await expect(traces.start(pixel, { ...hitches, categories: ["sched"] })).rejects.toThrow(
      "exactly one of template or categories",
    );
    await expect(traces.start(pixel, { timeLimitMs: 10_000 })).rejects.toThrow(
      "exactly one of template or categories",
    );
    await expect(traces.start(pixel, { ...hitches, bufferMb: 64 })).rejects.toThrow(
      "bufferMb applies only to a categories trace",
    );
    await expect(traces.start(pixel, { categories: ["app"], timeLimitMs: 10_000 })).rejects.toThrow(
      "needs an appId",
    );
    expect(recorder.started).toEqual([]);
  });

  test("a stop that fails before the recorder is signalled keeps the trace for a retry", async () => {
    const { manager: traces, recorder } = manager();
    recorder.unsignalledFailures = 1;
    await traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });

    await expect(traces.stop("trace-t-1")).rejects.toThrow("before SIGTERM");
    expect(traces.activeTraceIds()).toEqual(["trace-t-1"]);
    await expect(traces.start(pixel, hitches)).rejects.toThrow("already recording");

    expect(await traces.stop("trace-t-1")).toMatchObject({ state: "stopped" });
    expect(recorder.stops).toEqual(["trace-t-1", "trace-t-1"]);
    expect(traces.activeTraceIds()).toEqual([]);
  });

  test("release retries an unsignalled stop, so the device is free for its next owner (#18938)", async () => {
    const { manager: traces, recorder } = manager();
    recorder.unsignalledFailures = 1;
    await traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });

    await traces.stopSessionTracesOnDevice("s1", "emulator-5554");

    expect(recorder.stops).toEqual(["trace-t-1", "trace-t-1"]);
    expect(traces.activeTraceIds()).toEqual([]);
    await expect(
      traces.start(pixel, { ...hitches, ownerSessionUuid: "s2" }),
    ).resolves.toMatchObject({ traceId: "trace-t-2" });
  });

  test("release gives up after bounded unsignalled stops, and a later release stops it", async () => {
    const { manager: traces, recorder } = manager();
    recorder.unsignalledFailures = 3;
    await traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });

    await traces.stopSessionTracesOnDevice("s1", "emulator-5554");
    expect(recorder.stops).toHaveLength(3);
    expect(traces.activeTraceIds()).toEqual(["trace-t-1"]);

    await traces.stopSessionTracesOnDevice("s1", "emulator-5554");
    expect(traces.activeTraceIds()).toEqual([]);
  });

  test("a release during an in-flight start waits for it, then stops its recorder (#18938)", async () => {
    const { manager: traces, recorder } = manager();
    let releaseStart!: () => void;
    recorder.startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const starting = traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });
    expect(traces.hasSessionTraceOnDevice("s1", "emulator-5554")).toBe(true);
    expect(traces.hasSessionTraceOnDevice("s2", "emulator-5554")).toBe(false);

    let released = false;
    const releasing = traces.stopTracesForSession("s1").then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    releaseStart();
    await expect(starting).resolves.toMatchObject({ traceId: "trace-t-1" });
    await releasing;
    expect(recorder.stops).toEqual(["trace-t-1"]);
    expect(traces.activeTraceIds()).toEqual([]);
  });

  test("a release leaves another session's in-flight start alone", async () => {
    const { manager: traces, recorder } = manager();
    let releaseStart!: () => void;
    recorder.startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const starting = traces.start(pixel, { ...hitches, ownerSessionUuid: "s2" });

    await traces.stopSessionTracesOnDevice("s1", "emulator-5554");
    releaseStart();
    await starting;

    expect(recorder.stops).toEqual([]);
    expect(traces.activeTraceIds()).toEqual(["trace-t-1"]);
  });

  test("a failed in-flight start releases cleanly", async () => {
    const { manager: traces, recorder } = manager();
    let failStart!: (error: Error) => void;
    recorder.startGate = new Promise<void>((_resolve, reject) => {
      failStart = reject;
    });
    const starting = traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });
    const releasing = traces.stopTracesOnDevice("emulator-5554");

    failStart(new Error("adb: perfetto missing"));
    await expect(starting).rejects.toThrow("perfetto missing");
    await releasing;
    expect(recorder.stops).toEqual([]);
    expect(traces.hasSessionTraceOnDevice("s1", "emulator-5554")).toBe(false);
  });

  test("a session's stop on one device leaves its traces elsewhere and other sessions' alone", async () => {
    const { manager: traces, recorder } = manager();
    await traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });
    await traces.start(tablet, { ...hitches, ownerSessionUuid: "s1" });

    await traces.stopSessionTracesOnDevice("s2", "emulator-5554");
    await traces.stopSessionTracesOnDevice("s1", "emulator-5554");

    expect(recorder.stops).toEqual(["trace-t-1"]);
    expect(traces.activeTraceIds()).toEqual(["trace-t-2"]);
  });

  test("release resolves once the recorder is stopped, without waiting for the summary", async () => {
    const { manager: traces, recorder } = manager();
    let release!: () => void;
    recorder.summaryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });

    await traces.stopTracesForSession("s1");
    expect(traces.activeTraceIds()).toEqual([]);
    const summary = traces.stop("trace-t-1");

    release();
    expect(await summary).toMatchObject({ summary: { durationMs: 1_500 } });
    expect(recorder.stops).toEqual(["trace-t-1"]);
  });

  test("overlapping starts on one device cannot both reach the recorder", async () => {
    const { manager: traces, recorder } = manager();
    const first = traces.start(pixel, hitches);
    await expect(traces.start(pixel, hitches)).rejects.toThrow("still starting");
    await first;
    expect(recorder.started).toHaveLength(1);
  });
});

describe("PerformanceTraceManager discard (#18698)", () => {
  test("discard ends the recorder without stopping or summarising it and frees the device", async () => {
    const { manager: traces, recorder } = manager();
    await traces.start(pixel, { ...hitches, ownerSessionUuid: "s1" });

    await traces.discard("trace-t-1");

    expect(recorder.discards).toEqual(["trace-t-1"]);
    expect(recorder.stops).toEqual([]);
    expect(traces.activeTraceIds()).toEqual([]);
    expect(traces.lookup("trace-t-1")).toBeUndefined();
    await expect(traces.start(pixel, hitches)).resolves.toMatchObject({ traceId: "trace-t-2" });
  });

  test("discard leaves a trace a stop already took to that stop", async () => {
    const { manager: traces, recorder } = manager();
    await traces.start(pixel, hitches);
    const stopping = traces.stop("trace-t-1");

    await traces.discard("trace-t-1");
    await stopping;

    expect(recorder.discards).toEqual([]);
    expect(recorder.stops).toEqual(["trace-t-1"]);
  });
});
