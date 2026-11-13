import { describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { promises as fs } from "node:fs";
import { PlatformVideoCaptureBackend } from "../../../src/features/video/PlatformVideoCaptureBackend";
import type { VideoCaptureConfig } from "../../../src/features/video/VideoRecorderService";
import { ActionableError } from "../../../src/models/ActionableError";
import { logger } from "../../../src/utils/logger";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import type { FakeAdbProcess } from "../../fakes/FakeAdbProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import { useScratchRoot } from "../../helpers/scratchRoot";

const LAUNCH = "exec screenrecord";
const DEVICE_FILE = "/sdcard/auto-mobile-diagnostics.mp4";
const RETRY_DEVICE_FILE = "/sdcard/auto-mobile-diagnostics-retry.mp4";
const PROBE = "shell 'cat /proc/4321/cmdline 2>/dev/null; true'";
const OUR_CMDLINE = `screenrecord\u0000${DEVICE_FILE}\u0000`;

/** Schedules recorder failures on injected time; all other commands use the existing fake. */
class StartupAdb extends FakeAdbClient {
  launches = 0;
  constructor(
    private readonly timer: FakeTimer,
    private readonly failures: number,
  ) {
    super();
    this.setSpawnRunning(LAUNCH);
  }

  override async spawn(...args: Parameters<FakeAdbClient["spawn"]>) {
    await super.spawn(...args);
    const child = this.getSpawnedProcesses()[this.getSpawnedProcesses().length - 1];
    if (args[0].join(" ").includes(LAUNCH)) {
      this.launches++;
      if (this.launches <= this.failures) {
        this.timer.setTimeout(() => {
          child.stderr.emit("data", `encoder failed writing '${DEVICE_FILE}'`);
          child.stderr.destroy();
          child.exitCode = 255;
          child.emit("exit", 255, null);
        }, 700);
      }
    }
    return child;
  }
}

describe("Android recorder diagnostics and recovery (#17951)", () => {
  const scratch = useScratchRoot("android-recorder-diagnostics-");

  function setup(failures = 0, durationMs?: number) {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const client = new StartupAdb(timer, failures);
    const backend = new PlatformVideoCaptureBackend(new FakeAdbClientFactory(client), timer, {
      async codec() {
        return "h264";
      },
      async durationMs() {
        return durationMs;
      },
    });
    const config: VideoCaptureConfig = {
      recordingId: "diagnostics",
      outputDirectory: scratch.next(),
      outputPath: "unused",
      fileName: "video.mp4",
      startedAt: "1970-01-01T00:00:00.000Z",
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 100,
      format: "mp4",
      device: { platform: "android", deviceId: "fake-device", name: "Pixel" },
    };
    config.outputPath = path.join(config.outputDirectory, "video.mp4");
    return { backend, client, timer, config };
  }

  function exit(
    child: FakeAdbProcess,
    code: number | null,
    stderr = "",
    signal: NodeJS.Signals | null = null,
  ) {
    if (stderr) {
      child.stderr.emit("data", stderr);
    }
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  }

  test.each(["encoder died", ""])(
    "warns immediately after an abnormal exit with stderr %p",
    async (stderr) => {
      const { backend, client, timer, config } = setup();
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await backend.start(config);
        timer.advanceTime(600);
        exit(client.getSpawnedProcesses()[0], 255, stderr ? `${stderr}: '${DEVICE_FILE}'` : "");
        await drainMicrotasks(10);

        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0][0]);
        expect(message).toContain("code 255");
        expect(message).toContain("1600 ms");
        expect(message).toContain(
          "When launched with setsid, the device-side recorder keeps running",
        );
        expect(message).toContain("stop will signal it and collect the recording");
        expect(message).toContain(stderr || "stderr was empty");
        expect(message).not.toContain(DEVICE_FILE);
        if (stderr) {
          expect(message).toContain("<device recording file>");
        }
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("signal exits are also warned immediately", async () => {
    const { backend, client, config } = setup();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await backend.start(config);
      exit(client.getSpawnedProcesses()[0], null, "", "SIGKILL");
      await drainMicrotasks(10);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("signal SIGKILL"));
    } finally {
      warn.mockRestore();
    }
  });

  test("retries a 700 ms startup death once after cleanup and accepts the second launch", async () => {
    const { backend, client, timer, config } = setup(1);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const handle = await backend.start(config);

      expect(handle.recordingId).toBe(config.recordingId);
      expect(client.launches).toBe(2);
      const spawns = client.getSpawnCalls().map((args) => args.join(" "));
      expect(spawns[1]).toBe(`shell rm ${DEVICE_FILE}`);
      expect(spawns[2]).toContain(LAUNCH);
      expect(spawns[2]).toEndWith(RETRY_DEVICE_FILE);
      expect(timer.getCurrentTime()).toBeGreaterThanOrEqual(1700);
      expect(timer.getSleepHistory()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("encoder failed"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("retrying once"));
    } finally {
      warn.mockRestore();
    }
  });

  test("two startup deaths throw the existing ActionableError after exactly two launches", async () => {
    const { backend, client, config } = setup(2);
    const error = await backend.start(config).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error).toMatchObject({ message: expect.stringContaining("code 255") });
    expect(client.launches).toBe(2);
    const removals = client
      .getSpawnCalls()
      .map((args) => args.join(" "))
      .filter((command) => command.startsWith("shell rm "));
    expect(removals).toEqual([`shell rm ${DEVICE_FILE}`, `shell rm ${RETRY_DEVICE_FILE}`]);
  });

  test("a failed-start cleanup that never finishes cannot remove the retry's recording", async () => {
    const { backend, client, config } = setup(1);
    // The first attempt's rm hangs past the cleanup deadline and is abandoned, still pending.
    client.setSpawnRunning(`shell rm ${DEVICE_FILE}`);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const handle = await backend.start(config);
      expect(client.launches).toBe(2);
      expect(warn.mock.calls.map(([message]) => String(message))).toContainEqual(
        expect.stringContaining("cleanup did not finish"),
      );
      const launches = client
        .getSpawnCalls()
        .map((args) => args.join(" "))
        .filter((command) => command.includes(LAUNCH));
      expect(launches[1]).toEndWith(RETRY_DEVICE_FILE);
      // The accepted recording lives at a path the abandoned rm does not name.
      expect(handle.backendHandle).toMatchObject({ deviceTempPath: RETRY_DEVICE_FILE });
    } finally {
      warn.mockRestore();
    }
  });

  test("a retry's quality window excludes the failed attempt and its cleanup", async () => {
    const { backend, client, timer, config } = setup(1, 4000);
    // The failed attempt's cleanup runs to its full deadline before the retry launches.
    client.setSpawnRunning(`shell rm ${DEVICE_FILE}`);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const handle = await backend.start(config);
      expect(client.launches).toBe(2);
      expect(timer.now()).toBeGreaterThan(10_000);
      timer.advanceTime(3000);
      exit(client.getSpawnedProcesses()[client.getSpawnedProcesses().length - 1], 0);
      client.setCommandResult(`shell stat -c %s ${RETRY_DEVICE_FILE}`, "20000");
      await fs.writeFile(config.outputPath, Buffer.alloc(20000));

      const result = await backend.stop(handle);

      // A healthy ~4 s retry video over its own ~4 s window: no evidence warning.
      expect(result.warnings).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test("an aborted startup is never retried", async () => {
    const { backend, client, timer, config } = setup(2);
    const controller = new AbortController();
    timer.setTimeout(() => controller.abort(), 600);
    await expect(
      backend.start({ ...config, abortSignal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(client.launches).toBe(1);
  });

  test("a rejected tracked exit is observed before stop without an unhandled rejection", async () => {
    const { backend, client, config } = setup();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await backend.start(config);
      client.getSpawnedProcesses()[0].emit("error", new Error("transport lost"));
      await drainMicrotasks(10);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("transport lost");
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    [true, 3232, undefined, 255, null],
    [false, 3232, undefined, 255, null],
    [true, 20000, 1499, 255, null],
    [true, 3232, undefined, null, "SIGKILL"],
  ] as const)(
    "stop retains the short-video early-exit warning without logging twice (watcher %p, bytes %p, duration %p, code %p, signal %p)",
    async (waitForWatcher, bytes, duration, code, signal) => {
      const { backend, client, timer, config } = setup(0, duration);
      const handle = await backend.start(config);
      timer.advanceTime(3000 - timer.now());
      client.setCommandResult(`shell stat -c %s ${DEVICE_FILE}`, String(bytes));
      await fs.writeFile(config.outputPath, Buffer.alloc(bytes));
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        exit(client.getSpawnedProcesses()[0], code, "encoder died", signal);
        if (waitForWatcher) {
          await drainMicrotasks(10);
          expect(warn).toHaveBeenCalledTimes(1);
        }
        const result = await backend.stop(handle);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(result.warnings).toHaveLength(2);
        expect(result.warnings?.[0]).toContain("host adb session to the Android recorder exited");
        expect(result.warnings?.[0]).toContain(signal ? `signal ${signal}` : `code ${code}`);
        expect(result.warnings?.[0]).toContain(
          "before the stop was requested; the recording is shorter than requested.",
        );
        expect(result.warnings?.[0]).not.toContain("may end sooner");
        expect(result.warnings?.[1]).toContain("should not be used as evidence");
      } finally {
        warn.mockRestore();
      }
    },
  );

  test.each([
    [10000, undefined],
    [20000, 1500],
  ] as const)(
    "host exit 255 still stops, finalizes and pulls a surviving recorder (%p bytes, %p ms) without a quality warning",
    async (bytes, duration) => {
      const { backend, client, timer, config } = setup(0, duration);
      client.setSpawnStdout(LAUNCH, "4321\n");
      const handle = await backend.start(config);
      expect(handle.backendHandle).toMatchObject({ devicePid: { pid: 4321 } });
      timer.advanceTime(3000 - timer.now());
      exit(client.getSpawnedProcesses()[0], 255);
      // Still alive for SIGINT and two exit polls, despite an unchanged file.
      client.setCommandResultSequence(PROBE, [OUR_CMDLINE, OUR_CMDLINE, OUR_CMDLINE, ""]);
      client.setCommandResult(`shell stat -c %s ${DEVICE_FILE}`, String(bytes));
      await fs.writeFile(config.outputPath, Buffer.alloc(bytes));
      const info = spyOn(logger, "info").mockImplementation(() => {});
      try {
        const result = await backend.stop(handle);

        expect(result.sizeBytes).toBe(bytes);
        expect(result.warnings).toBeUndefined();
        const interactions = client.getInteractionLog();
        expect(interactions.slice(0, 2)).toEqual([
          { kind: "spawn", text: client.getSpawnCalls()[0].join(" ") },
          { kind: "command", text: PROBE },
        ]);
        expect(client.getAllCommands()[1]).toBe("shell kill -2 4321");
        const pullIndex = interactions.findIndex(({ text }) => text.startsWith("pull "));
        expect(pullIndex).toBeGreaterThan(0);
        const beforePull = interactions.slice(0, pullIndex);
        expect(beforePull.filter(({ text }) => text === PROBE)).toHaveLength(4);
        expect(
          beforePull.filter(({ text }) => text === `shell stat -c %s ${DEVICE_FILE}`),
        ).toHaveLength(2);
        expect(beforePull.slice(1, 6).map(({ text }) => text)).toEqual([
          PROBE,
          "shell kill -2 4321",
          PROBE,
          PROBE,
          PROBE,
        ]);
        expect(info.mock.calls.map(([message]) => String(message))).toContainEqual(
          expect.stringContaining("device recording was collected"),
        );
      } finally {
        info.mockRestore();
      }
    },
  );

  test.each(["20000", ""])(
    "host exit 255 retains a live device recorder's file without pulling (stat %p)",
    async (stat) => {
      const { backend, client, config } = setup();
      client.setSpawnStdout(LAUNCH, "4321\n");
      const handle = await backend.start(config);
      exit(client.getSpawnedProcesses()[0], 255);
      client.setCommandResult(PROBE, OUR_CMDLINE);
      client.setCommandResult(`shell stat -c %s ${DEVICE_FILE}`, stat);

      await expect(backend.stop(handle)).rejects.toMatchObject({ retainOwnership: true });

      expect(client.getAllCommands()).toContain("shell kill -2 4321");
      expect(client.getCommandCount(PROBE)).toBe(6);
      expect(client.getSpawnCalls().some(([command]) => command === "pull")).toBe(false);
      expect(client.wasSpawned(`rm ${DEVICE_FILE}`)).toBe(false);
    },
  );

  test.each([
    [3232, undefined, 500, true],
    [20000, 1499, 3000, true],
    [3232, 100, 10000, true],
    [10000, undefined, 3000, false],
    [20000, 1500, 3000, false],
    [20000, 1, 2999, false],
    [20000, undefined, 10000, false],
  ] as const)(
    "quality warning for %p bytes, %p ms video over %p ms window: %p",
    async (bytes, duration, window, warning) => {
      const { backend, client, timer, config } = setup(0, duration);
      const handle = await backend.start(config);
      // The recording window starts at the accepted launch (t=0) and ends before stop's
      // finalization waits.
      timer.advanceTime(Math.max(0, window - timer.now()));
      exit(client.getSpawnedProcesses()[0], 0);
      client.setCommandResult(`shell stat -c %s ${DEVICE_FILE}`, String(bytes));
      await fs.writeFile(config.outputPath, Buffer.alloc(bytes));

      const result = await backend.stop(handle);

      if (warning) {
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings?.[0]).toContain("much shorter than the recording window");
        expect(result.warnings?.[0]).toContain("should not be used as evidence");
      } else {
        expect(result.warnings).toBeUndefined();
      }
    },
  );

  test.each(["stop", "forceStop"] as const)(
    "our own %s never emits the exit watcher warning",
    async (method) => {
      const { backend, client, config } = setup();
      const handle = await backend.start(config);
      const child = client.getSpawnedProcesses()[0];
      child.kill = () => {
        exit(child, 255, "", "SIGINT");
        return true;
      };
      client.setCommandResult(`shell stat -c %s ${DEVICE_FILE}`, "20000");
      await fs.writeFile(config.outputPath, Buffer.alloc(20000));
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        if (method === "stop") {
          await backend.stop(handle);
        } else {
          await backend.forceStop(handle, { hostOnly: true });
        }
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );
});
