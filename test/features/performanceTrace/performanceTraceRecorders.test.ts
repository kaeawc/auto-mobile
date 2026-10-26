import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionableError, type BootedDevice, type ExecResult } from "../../../src/models";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { HostCommandOptions } from "../../../src/utils/HostCommandExecutor";
import {
  parsePerfettoBackgroundPid,
  PerfettoRecorder,
} from "../../../src/features/performanceTrace/PerfettoRecorder";
import type { PerfettoTraceProcessor } from "../../../src/features/performanceTrace/perfettoTraceProcessor";
import {
  XctraceRecorder,
  type XctraceHost,
  type XctraceRecorderDependencies,
} from "../../../src/features/performanceTrace/XctraceRecorder";
import { traceArtifactBytes } from "../../../src/features/performanceTrace/xctraceFinalization";
import { PerformanceTraceStopTimeoutError } from "../../../src/features/performanceTrace/PerformanceTraceStopTimeoutError";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/performanceTrace", name), "utf8");

const android: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const simulator: BootedDevice = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  name: "iPhone",
  platform: "ios",
};

function execResult(stdout: string, stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

class RecordingAdb {
  readonly calls: string[][] = [];
  probesUntilStopped = 1;
  /** Successive `wc -c` answers; the last repeats. */
  sizes = [4096, 4096];

  async execute(args: string[], _options?: AdbExecuteOptions): Promise<ExecResult> {
    this.calls.push(args);
    const command = args.join(" ");
    if (command.includes("perfetto --background")) {
      return execResult("Connected to the Perfetto traced service\n31337\n");
    }
    if (command.includes("kill -0")) {
      this.probesUntilStopped -= 1;
      return execResult(this.probesUntilStopped <= 0 ? "stopped\n" : "running\n");
    }
    if (command.includes("wc -c")) {
      const size = this.sizes.length > 1 ? this.sizes.shift()! : this.sizes[0]!;
      return execResult(`${size}\n`);
    }
    return execResult("");
  }
}

function perfetto(adb: RecordingAdb, processor?: PerfettoTraceProcessor) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return {
    timer,
    recorder: new PerfettoRecorder({
      adbFor: () => adb,
      traceProcessor: async () => processor,
      timer,
      stopPollAttempts: 3,
      flushPollAttempts: 4,
    }),
  };
}

const androidRequest = {
  traceId: "trace-1",
  device: android,
  template: "hitches" as const,
  appId: "com.example.app",
  timeLimitMs: 10_000,
  artifactDir: "/artifacts",
};

describe("Perfetto recorder (#14102)", () => {
  test("starts a background recorder with a base64 config through stdin", async () => {
    const adb = new RecordingAdb();
    const recording = await perfetto(adb).recorder.start(androidRequest);

    expect(recording.artifactPath).toBe(join("/artifacts", "automobile-trace-1.perfetto-trace"));
    const [shell, command] = adb.calls[0]!;
    expect(shell).toBe("shell");
    const encoded = command!.match(
      /^echo (\S+) \| base64 -d \| perfetto --background --txt -c - -o (\S+)$/,
    );
    expect(encoded?.[2]).toBe("/data/misc/perfetto-traces/automobile-trace-1.perfetto-trace");
    expect(Buffer.from(encoded![1]!, "base64").toString()).toContain("duration_ms: 10000");
  });

  test("stops with SIGTERM, waits for exit, pulls the trace and removes the device copy", async () => {
    const adb = new RecordingAdb();
    adb.probesUntilStopped = 2;
    const { recorder, timer } = perfetto(adb);
    const recording = await recorder.start(androidRequest);

    await recording.stop();

    expect(adb.calls.slice(1).map((call) => call.join(" "))).toEqual([
      "shell kill -TERM 31337 2>/dev/null; true",
      "shell kill -0 31337 2>/dev/null && echo running || echo stopped",
      "shell kill -0 31337 2>/dev/null && echo running || echo stopped",
      "shell wc -c < /data/misc/perfetto-traces/automobile-trace-1.perfetto-trace 2>/dev/null || echo 0",
      "shell wc -c < /data/misc/perfetto-traces/automobile-trace-1.perfetto-trace 2>/dev/null || echo 0",
      `pull /data/misc/perfetto-traces/automobile-trace-1.perfetto-trace ${recording.artifactPath}`,
      "shell rm -f /data/misc/perfetto-traces/automobile-trace-1.perfetto-trace",
    ]);
    expect(timer.getSleepHistory()).toEqual([250, 250]);
    expect(recording.warnings).toEqual([]);
  });

  test("waits for the trace file to fill before pulling, even though perfetto already exited (#14737)", async () => {
    const adb = new RecordingAdb();
    adb.sizes = [0, 0, 369_000, 369_000];
    const recording = await perfetto(adb).recorder.start(androidRequest);

    await recording.stop();

    const calls = adb.calls.map((call) => call.join(" "));
    const lastProbe = calls.map((call) => call.includes("wc -c")).lastIndexOf(true);
    expect(calls.filter((call) => call.includes("wc -c"))).toHaveLength(4);
    expect(calls.findIndex((call) => call.startsWith("pull"))).toBeGreaterThan(lastProbe);
  });

  test("fails with a typed error instead of pulling an empty trace (#14737)", async () => {
    const adb = new RecordingAdb();
    adb.sizes = [0];
    const recording = await perfetto(adb).recorder.start(androidRequest);

    await expect(recording.stop()).rejects.toThrow("trace is empty");
    expect(adb.calls.some((call) => call[0] === "pull")).toBe(false);
  });

  test("warns when perfetto never exits after SIGTERM", async () => {
    const adb = new RecordingAdb();
    adb.probesUntilStopped = 99;
    const recording = await perfetto(adb).recorder.start(androidRequest);
    await recording.stop();
    expect(recording.warnings).toEqual([expect.stringContaining("did not exit after SIGTERM")]);
  });

  test("fails start when perfetto prints no pid", async () => {
    const adb = new RecordingAdb();
    adb.execute = async (args) => (adb.calls.push(args), execResult("", "perfetto: not found"));
    await expect(perfetto(adb).recorder.start(androidRequest)).rejects.toThrow(
      "perfetto did not start on emulator-5554: perfetto: not found",
    );
  });

  test("summarises through the trace processor, or warns when none is installed", async () => {
    const adb = new RecordingAdb();
    const processor: PerfettoTraceProcessor = { query: async () => [{ dur: "2000000000" }] };
    const withProcessor = await perfetto(adb, processor).recorder.start(androidRequest);
    expect((await withProcessor.summarize()).summary.durationMs).toBe(2_000);

    const without = await perfetto(adb).recorder.start(androidRequest);
    expect(await without.summarize()).toEqual({
      summary: {},
      warnings: [expect.stringContaining("trace_processor_shell was not found")],
    });
  });

  test("reads the background pid from the last numeric token", () => {
    expect(parsePerfettoBackgroundPid("some log line\n4242\n")).toBe(4242);
    expect(parsePerfettoBackgroundPid("error: nope")).toBeUndefined();
  });
});

class FakeXctraceHost implements XctraceHost {
  readonly spawned: Array<{ file: string; args: string[]; child: FakeChildProcess }> = [];
  readonly exports: string[][] = [];
  startOutput = "Starting recording with the Hangs template. Ctrl-C to stop the recording.\n";

  constructor(private readonly timer: FakeTimer) {}

  spawn(file: string, args: string[]): FakeChildProcess {
    const child = new FakeChildProcess(this.timer);
    this.spawned.push({ file, args, child });
    queueMicrotask(() => child.stdout.push(this.startOutput));
    return child;
  }

  async executeCommand(
    _file: string,
    args: string[] = [],
    _options?: HostCommandOptions,
  ): Promise<ExecResult> {
    this.exports.push(args);
    if (args.includes("--toc")) {
      return execResult(fixture("xctrace-toc.xml"));
    }
    return execResult(fixture("xctrace-potential-hangs.xml"));
  }
}

function xctrace(pid: number | null = 4321, options: Partial<XctraceRecorderDependencies> = {}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const host = new FakeXctraceHost(timer);
  const recorder = new XctraceRecorder({
    host,
    resolvePid: async () => pid ?? undefined,
    timer,
    startTimeoutMs: 5_000,
    stopTimeoutMs: 5_000,
    artifactBytes: async () => 0,
    ...options,
  });
  return { host, recorder, timer };
}

const iosRequest = {
  traceId: "trace-2",
  device: simulator,
  template: "hangs" as const,
  appId: "com.example.app",
  timeLimitMs: 20_000,
  artifactDir: "/artifacts",
};

describe("xctrace recorder (#14102)", () => {
  test("attaches to the running app and stops with SIGINT so xctrace finalizes the trace", async () => {
    const { host, recorder } = xctrace();
    const recording = await recorder.start(iosRequest);

    expect(host.spawned[0]!.file).toBe("xcrun");
    expect(host.spawned[0]!.args).toContain("--attach");
    expect(host.spawned[0]!.args.slice(-2)).toEqual(["--attach", "4321"]);

    await recording.stop();
    expect(host.spawned[0]!.child.signalCode).toBe("SIGINT");
    expect(recording.warnings).toEqual([]);
  });

  test("does not signal an xctrace that already ended at its time limit (#14737)", async () => {
    const { host, recorder } = xctrace();
    const recording = await recorder.start(iosRequest);
    const child = host.spawned[0]!.child;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    const signals: Array<string | number | undefined> = [];
    child.kill = (signal) => (signals.push(signal), true);

    await recording.stop();

    expect(signals).toEqual([]);
    expect(child.signalCode).toBeNull();
  });

  test("fails typed and kills xctrace when it will not finalize after SIGINT (#14737)", async () => {
    const { host, recorder } = xctrace();
    const recording = await recorder.start(iosRequest);
    const child = host.spawned[0]!.child;
    const signals: Array<string | number | undefined> = [];
    child.kill = (signal) => (signals.push(signal), true);

    await expect(recording.stop()).rejects.toThrow(
      "did not finish finalising the trace within 5000 ms",
    );
    expect(signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test.each(["xctrace-export-malformed.stderr.txt", "xctrace-export-missing-template.stderr.txt"])(
    "flags real export failure %s as unreadable",
    async (name) => {
      const { host, recorder } = xctrace();
      const recording = await recorder.start(iosRequest);
      await recording.stop();
      host.executeCommand = async () => {
        throw new Error(fixture(name));
      };

      const { warnings } = await recording.summarize();

      expect(warnings[0]).toContain("unreadable");
    },
  );

  test("reports an empty run without a misleading duration or missing-table warning", async () => {
    const { host, recorder } = xctrace();
    const recording = await recorder.start({ ...iosRequest, template: "hitches" });
    const exported: string[][] = [];
    host.executeCommand = async (_file, args = []) => {
      exported.push(args);
      return execResult(fixture("xctrace-toc-empty-unfinalized-hitches-ios27.xml"));
    };
    expect(await recording.summarize()).toEqual({
      summary: {},
      warnings: [
        "xctrace saved the trace without any recorded run data (0 s, no tables), so there is nothing to summarise. The recording did not capture; retry on a less loaded host, or open the .trace in Instruments.",
      ],
    });
    expect(exported).toHaveLength(1);
    expect(exported[0]).toContain("--toc");
  });

  test.each(["stdout", "stderr"] as const)(
    "extends finalisation while %s remains active",
    async (stream) => {
      const { host, recorder, timer } = xctrace();
      const recording = await recorder.start(iosRequest);
      const child = host.spawned[0]!.child;
      child.kill = () => true;
      const started = timer.now();
      timer.setTimeout(() => child[stream].emit("data", "Saving output file..."), 4000);
      timer.setTimeout(() => child.emit("exit", 0, null), 8000);
      await recording.stop();
      expect(timer.now() - started).toBe(8000);
      expect(child[stream].listenerCount("data")).toBe(0);
    },
  );

  test("extends finalisation while the artifact grows", async () => {
    let bytes = 0;
    const { host, recorder, timer } = xctrace(4321, { artifactBytes: async () => ++bytes });
    const recording = await recorder.start(iosRequest);
    host.spawned[0]!.child.kill = () => true;
    timer.setTimeout(() => host.spawned[0]!.child.emit("exit", 0, null), 12000);
    await recording.stop();
    expect(bytes).toBeGreaterThan(3);
  });

  test("hard cap bounds continuous progress and carries timeout metadata", async () => {
    let bytes = 0;
    const { host, recorder, timer } = xctrace(4321, {
      artifactBytes: async () => ++bytes,
      stopMaxMs: 10000,
    });
    const recording = await recorder.start(iosRequest);
    const signals: Array<string | number | undefined> = [];
    host.spawned[0]!.child.kill = (signal) => (signals.push(signal), true);
    const started = timer.now();
    await expect(recording.stop()).rejects.toMatchObject({
      name: "PerformanceTraceStopTimeoutError",
      artifactPath: recording.artifactPath,
      waitedMs: 10000,
      lastActivityMs: started + 8000,
    });
    expect(signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("times out after progress stops, carrying the last activity timestamp", async () => {
    const { host, recorder, timer } = xctrace();
    const recording = await recorder.start(iosRequest);
    const child = host.spawned[0]!.child;
    child.kill = () => true;
    const started = timer.now();
    timer.setTimeout(() => child.stderr.emit("data", "Saving output file..."), 4000);
    await expect(recording.stop()).rejects.toMatchObject({
      waitedMs: 9000,
      lastActivityMs: started + 4000,
    });
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("uses the default 60 second inactivity window and a typed actionable error", async () => {
    const { host, recorder } = xctrace(4321, { stopTimeoutMs: undefined });
    const recording = await recorder.start(iosRequest);
    host.spawned[0]!.child.kill = () => true;
    const failure = recording.stop();
    await expect(failure).rejects.toBeInstanceOf(PerformanceTraceStopTimeoutError);
    await expect(failure).rejects.toBeInstanceOf(ActionableError);
    await expect(failure).rejects.toMatchObject({ waitedMs: 60000, lastActivityMs: undefined });
  });

  test("uses the default 180 second cap even with continuous artifact growth", async () => {
    let bytes = 0;
    const { host, recorder } = xctrace(4321, {
      stopTimeoutMs: undefined,
      artifactBytes: async () => ++bytes,
    });
    const recording = await recorder.start(iosRequest);
    host.spawned[0]!.child.kill = () => true;
    await expect(recording.stop()).rejects.toMatchObject({ waitedMs: 180000 });
  });

  test("an unresponsive artifact probe cannot hold up the stop deadline", async () => {
    const { host, recorder } = xctrace(4321, { artifactBytes: () => new Promise(() => {}) });
    const recording = await recorder.start(iosRequest);
    host.spawned[0]!.child.kill = () => true;
    await expect(recording.stop()).rejects.toMatchObject({ waitedMs: 5000 });
  });

  test("summarises the template table from xctrace export", async () => {
    const { host, recorder } = xctrace();
    const recording = await recorder.start(iosRequest);
    await recording.stop();

    const { summary, warnings } = await recording.summarize();

    expect(summary).toMatchObject({ durationMs: 5_250, endReason: "Time limit reached" });
    expect(summary.hangs?.[0]).toEqual({ durationMs: 1_200, startMs: 3_000, type: "Hang" });
    expect(warnings).toEqual([]);
    expect(host.exports[1]).toEqual([
      "xctrace",
      "export",
      "--input",
      recording.artifactPath,
      "--xpath",
      '/trace-toc/run[@number="1"]/data/table[@schema="potential-hangs"]',
    ]);
  });

  test("records all processes with a warning when the app is not running", async () => {
    const { host, recorder } = xctrace(null);
    const recording = await recorder.start(iosRequest);
    expect(host.spawned[0]!.args.at(-1)).toBe("--all-processes");
    expect(recording.warnings).toEqual([expect.stringContaining("not running")]);
  });

  test("refuses templates that need a target without one", async () => {
    await expect(
      xctrace(null).recorder.start({ ...iosRequest, template: "allocations" }),
    ).rejects.toThrow("not running");
    await expect(
      xctrace().recorder.start({ ...iosRequest, template: "appLaunch", appId: undefined }),
    ).rejects.toThrow("needs an appId");
  });

  test("fails start with xctrace's output when it exits before recording", async () => {
    const { host, recorder } = xctrace();
    host.startOutput = "";
    host.spawn = (file, args) => {
      const child = new FakeChildProcess(new FakeTimer());
      host.spawned.push({ file, args, child });
      queueMicrotask(() => {
        child.stderr.push("xctrace: Device not found\n");
        setImmediate(() => child.emit("close", 1, null));
      });
      return child;
    };
    await expect(recorder.start(iosRequest)).rejects.toThrow("Device not found");
  });
});

describe("trace artifact byte measurement", () => {
  test("sums nested file bytes, observes growth, and treats a missing bundle as zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "trace-size-"));
    try {
      expect(await traceArtifactBytes(join(root, "missing.trace"))).toBe(0);
      await mkdir(join(root, "run"));
      await writeFile(join(root, "toc"), "123");
      await writeFile(join(root, "run", "data"), "12345");
      expect(await traceArtifactBytes(root)).toBe(8);
      await writeFile(join(root, "run", "data"), "1234567");
      expect(await traceArtifactBytes(root)).toBe(10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
