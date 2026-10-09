import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import {
  PlatformVideoCaptureBackend,
  clampBitrateKbps,
} from "../../../src/features/video/PlatformVideoCaptureBackend";
import type {
  RecordingHandle,
  VideoCaptureConfig,
} from "../../../src/features/video/VideoRecorderService";
import {
  VideoCaptureFinalizationError,
  parseVideoRecordingConfig,
} from "../../../src/features/video/VideoRecorderService";
import { type BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";

const screenrecordLivenessCommand =
  'shell \'pidof screenrecord; printf "pidof-status:%s\\n" "$?"\'';

describe("PlatformVideoCaptureBackend - Unit Tests", () => {
  let backend: PlatformVideoCaptureBackend;
  let tempDir: string;

  let rootDir: string;
  let fixtureIndex = 0;
  let testTimer: FakeTimer;

  beforeAll(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "platform-video-test-"));
  });

  beforeEach(() => {
    testTimer = new FakeTimer();
    testTimer.enableAutoAdvance();
    backend = new PlatformVideoCaptureBackend(new FakeAdbClientFactory(), testTimer);
    // Unique paths preserve each test's absent-file assertions without allocating
    // a directory for configuration, process-control, or parser-only tests.
    tempDir = path.join(rootDir, String(fixtureIndex++));
  });

  afterAll(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  async function writeVideoFixture(outputPath: string, data: string | Buffer): Promise<void> {
    await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
    await fsPromises.writeFile(outputPath, data);
  }

  describe("Interface Compliance", () => {
    test("implements VideoCaptureBackend interface", () => {
      expect(typeof backend.start).toBe("function");
      expect(typeof backend.stop).toBe("function");
    });
  });

  describe("Configuration Validation", () => {
    test("rejects start when device is missing", async () => {
      const configWithoutDevice: VideoCaptureConfig = {
        recordingId: "test-recording",
        outputDirectory: tempDir,
        outputPath: path.join(tempDir, "video.mp4"),
        fileName: "video.mp4",
        startedAt: new Date().toISOString(),
        qualityPreset: "low",
        targetBitrateKbps: 1000,
        maxThroughputMbps: 5,
        fps: 15,
        maxArchiveSizeMb: 2048,
        format: "mp4",
      };

      await expect(backend.start(configWithoutDevice)).rejects.toThrow("Device is required");
    });

    test("rejects unsupported platform", async () => {
      const unsupportedDevice: BootedDevice = {
        platform: "windows" as any,
        deviceId: "test",
        name: "Test Device",
      };

      const config: VideoCaptureConfig = {
        recordingId: "test-recording",
        outputDirectory: tempDir,
        outputPath: path.join(tempDir, "video.mp4"),
        fileName: "video.mp4",
        startedAt: new Date().toISOString(),
        qualityPreset: "low",
        targetBitrateKbps: 1000,
        maxThroughputMbps: 5,
        fps: 15,
        maxArchiveSizeMb: 2048,
        format: "mp4",
        device: unsupportedDevice,
      };

      await expect(backend.start(config)).rejects.toThrow("Unsupported platform");
    });
  });

  // The platform-native `simctl recordVideo` branch was unreachable dead code:
  // HybridVideoCaptureBackend routes every iOS device to FfmpegVideoProcessingBackend.
  // The dead branch spawned the recorder with all stdio ignored, so a failed capture
  // surfaced only an exit code with no stderr to diagnose it. It was removed (issue
  // #4773); iOS callers are now rejected explicitly so a future mis-wire fails loudly
  // instead of silently, and the error points at the correct backend.
  test("rejects iOS recording and points at the ffmpeg backend (issue #4773)", async () => {
    const device: BootedDevice = { platform: "ios", deviceId: "ios-platform-udid", name: "iPhone" };

    await expect(
      backend.start({
        recordingId: "recording",
        outputDirectory: tempDir,
        outputPath: path.join(tempDir, "video.mp4"),
        fileName: "video.mp4",
        startedAt: new Date().toISOString(),
        qualityPreset: "low",
        targetBitrateKbps: 1000,
        maxThroughputMbps: 5,
        fps: 15,
        maxArchiveSizeMb: 2048,
        format: "mp4",
        device,
      }),
    ).rejects.toThrow(/FfmpegVideoProcessingBackend/);
  });

  test("does not retain startup cancellation after an Android capture starts", async () => {
    const fakeFactory = new FakeAdbClientFactory();
    const backend = new PlatformVideoCaptureBackend(fakeFactory, testTimer);
    const controller = new AbortController();

    await backend.start({
      recordingId: "recording",
      outputDirectory: tempDir,
      outputPath: path.join(tempDir, "video.mp4"),
      fileName: "video.mp4",
      startedAt: new Date().toISOString(),
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 2048,
      format: "mp4",
      device: {
        platform: "android",
        deviceId: "android-emulator",
        name: "Android Emulator",
      },
      abortSignal: controller.signal,
    });

    const fakeClient = fakeFactory.getFakeClient();
    expect(fakeClient.getSpawnOptions()[0]).toEqual({
      signal: controller.signal,
      abortSignalScope: "startup",
    });

    controller.abort();

    expect(fakeClient.getSpawnedProcesses()[0]?.killed).toBe(false);
  });

  test("pins a selected foldable panel by physical display ID", async () => {
    const fakeFactory = new FakeAdbClientFactory();
    fakeFactory
      .getFakeClient()
      .setCommandResult(
        "shell cmd display get-displays",
        'Display id 0: DisplayInfo{uniqueId "local:11" type INTERNAL, real 100 x 200}\n' +
          'Display id 3: DisplayInfo{uniqueId "local:22" type INTERNAL, real 200 x 300}',
      );
    const device: BootedDevice = {
      platform: "android",
      deviceId: "foldable-video",
      name: "Foldable",
      displays: {
        panels: [
          { key: "11", role: "cover", sizePx: { width: 100, height: 200 } },
          { key: "22", role: "inner", sizePx: { width: 200, height: 300 } },
        ],
        postures: ["closed", "opened"],
      },
    };
    const config: VideoCaptureConfig = {
      recordingId: "foldable-recording",
      outputDirectory: tempDir,
      outputPath: path.join(tempDir, "foldable.mp4"),
      fileName: "foldable.mp4",
      startedAt: "1970-01-01T00:00:00.000Z",
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 100,
      format: "mp4",
      device,
      display: "inner",
    };

    await new PlatformVideoCaptureBackend(fakeFactory, testTimer).start(config);
    expect(fakeFactory.getFakeClient().getSpawnCalls()[0]?.join(" ")).toContain("--display-id 22");

    await new PlatformVideoCaptureBackend(fakeFactory, testTimer).start({
      ...config,
      recordingId: "single-recording",
      device: { platform: "android", deviceId: "single", name: "Phone" },
      display: undefined,
    });
    expect(fakeFactory.getFakeClient().getSpawnCalls()[1]?.join(" ")).not.toContain("--display-id");
  });

  test("unknown API retries once without display flag after an immediate usage error", async () => {
    const fakeFactory = new FakeAdbClientFactory();
    fakeFactory
      .getFakeClient()
      .setSpawnExit(
        "--display-id",
        1,
        "screenrecord: unknown option --display-id\nUsage: screenrecord",
      );
    fakeFactory
      .getFakeClient()
      .setCommandResult(
        "shell cmd display get-displays",
        'Display id 0: DisplayInfo{uniqueId "local:11" type INTERNAL, real 100 x 200}\n' +
          'Display id 3: DisplayInfo{uniqueId "local:22" type INTERNAL, real 200 x 300}',
      );
    const handle = await new PlatformVideoCaptureBackend(fakeFactory, testTimer).start({
      recordingId: "unknown-api",
      outputDirectory: tempDir,
      outputPath: path.join(tempDir, "video.mp4"),
      fileName: "video.mp4",
      startedAt: "1970-01-01T00:00:00.000Z",
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 100,
      format: "mp4",
      device: {
        platform: "android",
        deviceId: "unknown-api",
        name: "Foldable",
        displays: {
          panels: [
            { key: "11", role: "cover", sizePx: { width: 100, height: 200 } },
            { key: "22", role: "inner", sizePx: { width: 200, height: 300 } },
          ],
          postures: [],
        },
      },
    });
    const calls = fakeFactory.getFakeClient().getSpawnCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.join(" ")).toContain("--display-id");
    expect(calls[1]?.join(" ")).not.toContain("--display-id");
    // The retry keeps the pid-reporting wrapper.
    expect(calls[1]?.[1]).toStartWith("echo $$; exec screenrecord ");
    expect(handle.warning).toContain("rejected --display-id");
    expect(handle.physicalDisplayId).toBeUndefined();
  });

  describe("Stop Operation", () => {
    test("rejects stop when backend handle is missing", async () => {
      const invalidHandle: RecordingHandle = {
        recordingId: "test",
        outputPath: path.join(tempDir, "test.mp4"),
        startedAt: new Date().toISOString(),
        backendHandle: undefined,
      };

      await expect(backend.stop(invalidHandle)).rejects.toThrow("Missing backend handle");
    });

    test("rejects stop when backend handle has wrong type", async () => {
      const invalidHandle: RecordingHandle = {
        recordingId: "test",
        outputPath: path.join(tempDir, "test.mp4"),
        startedAt: new Date().toISOString(),
        backendHandle: { wrong: "type" } as any,
      };

      await expect(backend.stop(invalidHandle)).rejects.toThrow();
    });
  });

  describe("Android stop sequence (issue #1960)", () => {
    test.each(["exit", "error", "reject"] as const)(
      "keeps cleanup after pull and before codec probing when cleanup ends with %s",
      async (outcome) => {
        const factory = new FakeAdbClientFactory();
        const adb = factory.getFakeClient();
        if (outcome === "error") {
          adb.setSpawnError("shell rm ", new Error("cleanup event failed"));
        } else if (outcome === "reject") {
          adb.setSpawnRejection("shell rm ", new Error("cleanup spawn failed"));
        }
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        const outputPath = path.join(tempDir, "cleanup.mp4");
        await writeVideoFixture(outputPath, "fake-video");
        const codecProbe = {
          async codec(filePath: string): Promise<string> {
            expect(filePath).toBe(outputPath);
            expect(adb.getSpawnCalls()).toEqual([
              ["pull", "/sdcard/auto-mobile-test.mp4", outputPath],
              ["shell", "rm", "/sdcard/auto-mobile-test.mp4"],
            ]);
            return "h264";
          },
        };
        const process = new FakeChildProcess(timer);
        process.exitCode = 0;
        const handle = buildAndroidStopHandle(outputPath, process);

        const result = await new PlatformVideoCaptureBackend(factory, timer, codecProbe).stop(
          handle,
        );

        expect(result.codec).toBe("h264");
        expect(adb.getAllCommands()).toEqual([
          "shell pkill -2 screenrecord",
          "shell stat -c %s /sdcard/auto-mobile-test.mp4",
          "shell stat -c %s /sdcard/auto-mobile-test.mp4",
          "shell stat -c %s /sdcard/auto-mobile-test.mp4",
          "shell stat -c %s /sdcard/auto-mobile-test.mp4",
          "shell stat -c %s /sdcard/auto-mobile-test.mp4",
        ]);
      },
    );

    test.each([null, 0, 1])(
      "pins exit diagnostics for code %j after codec probing",
      async (exitCode) => {
        const factory = new FakeAdbClientFactory();
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        const events: string[] = [];
        const warn = spyOn(logger, "warn").mockImplementation((message) => {
          events.push(String(message));
        });
        const info = spyOn(logger, "info").mockImplementation((message) => {
          events.push(String(message));
        });
        try {
          const process = new FakeChildProcess(timer);
          process.exitCode = 0;
          const handle = buildAndroidStopHandle(path.join(tempDir, "diagnostics.mp4"), process);
          const backendHandle = handle.backendHandle as {
            exitState: { exitCode: number | null };
            stderr: string[];
          };
          // The recorder exits in response to the stop request (a code-1 exit seen BEFORE
          // the stop is a crash, covered by the #10186 tests), so apply the exit state
          // when the device-side stop command is issued.
          const adb = factory.getFakeClient();
          const executeCommand = adb.executeCommand.bind(adb);
          let exited = false;
          spyOn(adb, "executeCommand").mockImplementation(async (...args) => {
            if (!exited) {
              exited = true;
              backendHandle.exitState.exitCode = exitCode;
              backendHandle.stderr.push("first", "second");
            }
            return executeCommand(...args);
          });
          const probe = {
            async codec(): Promise<string> {
              events.push("codec");
              return "hevc";
            },
          };

          await writeVideoFixture(handle.outputPath, "fake-video");
          const result = await new PlatformVideoCaptureBackend(factory, timer, probe).stop(handle);

          expect(result.codec).toBe("hevc");
          expect(events.slice(events.indexOf("codec"))).toEqual([
            "codec",
            ...(exitCode === 1 ? ["[VideoCapture] Recording exited with code 1: firstsecond"] : []),
            "[VideoCapture] Stderr output: firstsecond",
          ]);
        } finally {
          warn.mockRestore();
          info.mockRestore();
        }
      },
    );

    function buildAndroidStopHandle(
      outputPath: string,
      fakeProcess: FakeChildProcess,
      exitPromise: Promise<void> = Promise.resolve(),
    ): RecordingHandle {
      const androidHandle = {
        kind: "android" as const,
        process: fakeProcess,
        outputStream: { end: () => undefined },
        exitState: {
          exitCode: fakeProcess.exitCode,
          signal: fakeProcess.signalCode,
          endedAt: new Date().toISOString(),
        },
        exitPromise,
        stderr: [] as string[],
        device: {
          platform: "android",
          deviceId: "test-emulator",
          name: "Test Android Emulator",
        } satisfies BootedDevice,
        deviceTempPath: "/sdcard/auto-mobile-test.mp4",
      };

      return {
        recordingId: "test-stop-sequence",
        outputPath,
        startedAt: new Date().toISOString(),
        backendHandle: androidHandle as any,
      };
    }

    function spyOnKill(fakeProcess: FakeChildProcess): Array<NodeJS.Signals | number | undefined> {
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const originalKill = fakeProcess.kill.bind(fakeProcess);
      fakeProcess.kill = (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        return originalKill(signal);
      };
      return signals;
    }

    test("forceStop sends SIGKILL to both the device recorder and host adb process", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeProcess = new FakeChildProcess(testTimer);
      const backend = new PlatformVideoCaptureBackend(fakeFactory, testTimer);
      const handle = buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess);
      const signals = spyOnKill(fakeProcess);

      await backend.forceStop(handle);

      expect(fakeFactory.getFakeClient().wasCommandExecuted("shell pkill -9 screenrecord")).toBe(
        true,
      );
      expect(
        fakeFactory.getFakeClient().wasCommandExecuted("shell rm -f /sdcard/auto-mobile-test.mp4"),
      ).toBe(true);
      expect(signals).toContain("SIGKILL");
    });

    test("forceStop with deviceWide:false runs no device-wide kill but reaps host adb and removes our temp file", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeProcess = new FakeChildProcess(testTimer);
      const backend = new PlatformVideoCaptureBackend(fakeFactory, testTimer);
      const handle = buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess);
      const signals = spyOnKill(fakeProcess);

      await backend.forceStop(handle, { deviceWide: false });

      const commands = fakeFactory.getFakeClient().getAllCommands();
      expect(commands.filter((command) => /pkill|killall|kill /.test(command))).toEqual([]);
      expect(commands).toContain("shell rm -f /sdcard/auto-mobile-test.mp4");
      expect(signals).toContain("SIGKILL");
    });

    test("forceStop surfaces device temp-file cleanup failures", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      fakeFactory
        .getFakeClient()
        .setCommandError("shell rm -f /sdcard/auto-mobile-test.mp4", new Error("device offline"));
      const fakeProcess = new FakeChildProcess(testTimer);
      const backend = new PlatformVideoCaptureBackend(fakeFactory, testTimer);

      await expect(
        backend.forceStop(buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess)),
      ).rejects.toThrow("device temp-file cleanup failed: device offline");
    });

    test("forceStop kills host adb before a stalled device command can consume shutdown time", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      fakeFactory.getFakeClient().setHangingCommand("shell pkill -9 screenrecord");
      const fakeProcess = new FakeChildProcess(testTimer);
      const backend = new PlatformVideoCaptureBackend(fakeFactory, testTimer);
      const signals = spyOnKill(fakeProcess);

      const pendingForceStop = backend.forceStop(
        buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess),
      );
      await Promise.resolve();

      expect(signals).toContain("SIGKILL");
      void pendingForceStop;
    });

    test("forceStop SIGKILLs a host adb process after graceful SIGINT was sent", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.killed = true;
      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const signals = spyOnKill(fakeProcess);

      await expect(
        backend.forceStop(
          buildAndroidStopHandle(
            path.join(tempDir, "out.mp4"),
            fakeProcess,
            new Promise<void>(() => {}),
          ),
        ),
      ).rejects.toThrow("host adb process cleanup failed");

      expect(signals).toContain("SIGKILL");
    });

    test("sends device-side `pkill -2 screenrecord` as the first ADB command on stop", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;
      const handle = buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess);

      await writeVideoFixture(handle.outputPath, "fake-video");
      await backend.stop(handle);

      const commands = fakeClient.getAllCommands();
      expect(commands[0]).toBe("shell pkill -2 screenrecord");
    });

    test("does NOT signal host adb when the device-side pkill caused it to exit on its own", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;
      const killSignals = spyOnKill(fakeProcess);

      const handle = buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess);

      await writeVideoFixture(handle.outputPath, "fake-video");
      await backend.stop(handle);

      expect(killSignals).toEqual([]);
    });

    test("disarms its graceful-exit timeout through the injected timer once host adb has exited", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      // Observe the arm/disarm pair on the *injected* timer. The bug used the
      // global clearTimeout, so the 10 s SIGINT callback armed via
      // this.timer.setTimeout was never cancelled and could fire after the
      // recording finished (issue #4170).
      const armedHandles: NodeJS.Timeout[] = [];
      const clearedHandles: NodeJS.Timeout[] = [];
      const originalSetTimeout = fakeTimer.setTimeout.bind(fakeTimer);
      const originalClearTimeout = fakeTimer.clearTimeout.bind(fakeTimer);
      fakeTimer.setTimeout = (callback: () => void, ms: number) => {
        const handle = originalSetTimeout(callback, ms);
        if (ms === 10000) {
          armedHandles.push(handle);
        }
        return handle;
      };
      fakeTimer.clearTimeout = (handle: NodeJS.Timeout) => {
        clearedHandles.push(handle);
        originalClearTimeout(handle);
      };

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0; // host adb already exited
      const handle = buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess);

      // stop() rejects later at the adb pull step; the disarm happens first.
      await backend.stop(handle).catch(() => undefined);

      expect(armedHandles).toHaveLength(1);
      expect(clearedHandles).toContain(armedHandles[0]);
    });

    test("falls back to host SIGINT when device-side pkill fails and host adb is still running", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      fakeClient.setCommandError("shell pkill -2 screenrecord", new Error("device offline"));
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      // exitCode stays null → host adb still running when stop() begins
      const killSignals: Array<NodeJS.Signals | number | undefined> = [];

      let resolveExit!: () => void;
      const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });

      fakeProcess.kill = (signal?: NodeJS.Signals | number) => {
        killSignals.push(signal);
        if (signal === "SIGINT") {
          fakeProcess.exitCode = 0;
          fakeProcess.killed = true;
          resolveExit();
        }
        return true;
      };

      const handle = buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess);
      (handle.backendHandle as any).exitPromise = exitPromise;
      (handle.backendHandle as any).exitState.exitCode = null;

      await writeVideoFixture(handle.outputPath, "fake-video");
      await backend.stop(handle);

      expect(killSignals).toContain("SIGINT");
      expect(fakeClient.wasCommandExecuted("shell pkill -2 screenrecord")).toBe(true);
    });

    test("pulls the recording, cleans up the /sdcard temp, and reports the pulled file size", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;

      // Simulate the pulled artifact so getFileSize returns a real byte count.
      const outputPath = path.join(tempDir, "out.mp4");
      await writeVideoFixture(outputPath, Buffer.alloc(4096, 1));
      const handle = buildAndroidStopHandle(outputPath, fakeProcess);

      const result = await backend.stop(handle);

      // The pull targets the device temp path → the host output path.
      expect(fakeClient.getSpawnCalls()[0]).toEqual([
        "pull",
        "/sdcard/auto-mobile-test.mp4",
        outputPath,
      ]);
      // The /sdcard temp file is removed afterwards.
      expect(fakeClient.wasSpawned("rm /sdcard/auto-mobile-test.mp4")).toBe(true);
      expect(result.sizeBytes).toBe(4096);
      expect(result.recordingId).toBe("test-stop-sequence");
    });

    test("reports the probed codec instead of a hard-coded constant (#4965)", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const probedPaths: string[] = [];
      const codecProbe = {
        async codec(filePath: string): Promise<string | undefined> {
          probedPaths.push(filePath);
          return "h264";
        },
      };
      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer, codecProbe);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;

      const outputPath = path.join(tempDir, "probed.mp4");
      await writeVideoFixture(outputPath, Buffer.alloc(64, 1));
      const handle = buildAndroidStopHandle(outputPath, fakeProcess);

      const result = await backend.stop(handle);

      expect(result.codec).toBe("h264");
      expect(probedPaths).toEqual([outputPath]);
    });

    test("reports the container duration separately from wall-clock time", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const codecProbe = {
        async codec(): Promise<string | undefined> {
          return "h264";
        },
        async durationMs(): Promise<number | undefined> {
          return 18200;
        },
      };
      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer, codecProbe);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;
      const outputPath = path.join(tempDir, "duration.mp4");
      await writeVideoFixture(outputPath, Buffer.alloc(64, 1));

      const result = await backend.stop(buildAndroidStopHandle(outputPath, fakeProcess));

      expect(result.videoDurationMs).toBe(18200);
      expect(result.durationMs).toBeUndefined();
    });

    // issue #6291: stopping immediately after start races screenrecord's own
    // flush on the device, so a fixed 1s wait isn't always enough — poll the
    // device file's size until it stabilizes before ever attempting the pull.
    test("polls the device file size until it stabilizes before pulling (issue #6291)", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      // Not flushed yet, then a size that stabilizes across two checks.
      fakeClient.setCommandResultSequence("shell stat -c %s /sdcard/auto-mobile-test.mp4", [
        "0",
        "512",
        "512",
      ]);

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;
      const outputPath = path.join(tempDir, "finalize.mp4");
      await writeVideoFixture(outputPath, Buffer.alloc(512, 1));
      const handle = buildAndroidStopHandle(outputPath, fakeProcess);

      const result = await backend.stop(handle);

      expect(fakeClient.getCommandCount("shell stat -c %s /sdcard/auto-mobile-test.mp4")).toBe(3);
      expect(fakeClient.getSpawnCalls().filter((call) => call[0] === "pull")).toHaveLength(1);
      expect(result.sizeBytes).toBe(512);

      // Assert ORDER, not just totals: a regression that moved the finalize
      // poll to run after `adb pull` would still satisfy the two counts above
      // while reintroducing the #6291 race. Every finalize `stat` poll must
      // precede the pull in the merged call sequence.
      const interactionLog = fakeClient.getInteractionLog();
      const statIndices = interactionLog
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.kind === "command" && entry.text.includes("shell stat -c %s"))
        .map(({ index }) => index);
      const pullIndex = interactionLog.findIndex(
        (entry) => entry.kind === "spawn" && entry.text.startsWith("pull "),
      );

      expect(statIndices).toHaveLength(3);
      expect(pullIndex).toBeGreaterThan(-1);
      expect(Math.max(...statIndices)).toBeLessThan(pullIndex);
    });

    test("retains a recording that never stabilizes instead of pulling a truncated file", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      fakeClient.setCommandResultSequence("shell stat -c %s /sdcard/auto-mobile-test.mp4", [
        "128",
        "256",
        "384",
        "512",
        "640",
      ]);

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;
      const handle = buildAndroidStopHandle(path.join(tempDir, "unstable.mp4"), fakeProcess);

      await expect(backend.stop(handle)).rejects.toMatchObject({ retainOwnership: true });

      expect(fakeClient.getCommandCount("shell stat -c %s /sdcard/auto-mobile-test.mp4")).toBe(5);
      expect(fakeClient.getSpawnCalls().filter((call) => call[0] === "pull")).toHaveLength(0);
      expect(fakeClient.wasSpawned("rm /sdcard/auto-mobile-test.mp4")).toBe(false);
    });

    test("fails terminally and removes a zero-byte device file after capture exit", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      fakeClient.setCommandResult(screenrecordLivenessCommand, "pidof-status:1\n");
      fakeClient.setCommandResultSequence("shell stat -c %s /sdcard/auto-mobile-test.mp4", [
        "0",
        "0",
        "0",
        "0",
        "0",
      ]);

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;
      const handle = buildAndroidStopHandle(path.join(tempDir, "empty.mp4"), fakeProcess);

      const error = await backend.stop(handle).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
      expect(error).toMatchObject({
        retainOwnership: false,
        message: expect.stringContaining("no usable video"),
      });
      expect(fakeClient.getCommandCount("shell stat -c %s /sdcard/auto-mobile-test.mp4")).toBe(5);
      expect(fakeClient.getSpawnCalls().filter((call) => call[0] === "pull")).toHaveLength(0);
      expect(fakeClient.wasSpawned("rm /sdcard/auto-mobile-test.mp4")).toBe(true);
      expect(fakeClient.getCommandCount(screenrecordLivenessCommand)).toBe(1);
      expect(fakeTimer.getSleepHistory()).toEqual([1000, 300, 300, 300, 300, 300]);
      expect(
        fakeClient
          .getInteractionLog()
          .filter((entry) => entry.kind === "command")
          .slice(-1),
      ).toEqual([{ kind: "command", text: screenrecordLivenessCommand }]);
    });

    test.each(["alive", "unreachable", "unparseable", "query error", "timeout"] as const)(
      "retains zero-byte Android capture and retries stop when device liveness is %s",
      async (liveness) => {
        const factory = new FakeAdbClientFactory();
        const adb = factory.getFakeClient();
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        adb.setCommandResult("shell stat -c %s /sdcard/auto-mobile-test.mp4", "0");
        if (liveness === "unreachable" || liveness === "timeout") {
          adb.setCommandError(screenrecordLivenessCommand, new Error(liveness));
          adb.setCommandError("shell pkill -2 screenrecord", new Error(liveness));
        } else {
          adb.setCommandResult(
            screenrecordLivenessCommand,
            liveness === "alive"
              ? "1234\npidof-status:0\n"
              : liveness === "query error"
                ? "pidof-status:1\n"
                : "garbage",
            liveness === "query error" ? "pidof failed" : "",
          );
        }
        const capture = new FakeChildProcess(timer);
        capture.exitCode = 0;
        const handle = buildAndroidStopHandle(path.join(tempDir, "retained.mp4"), capture);
        const backend = new PlatformVideoCaptureBackend(factory, timer);
        for (let attempt = 1; attempt <= 2; attempt++) {
          const error = await backend.stop(handle).catch((error: unknown) => error);
          expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
          expect(error).toMatchObject({
            retainOwnership: true,
            message: expect.stringContaining("stopping the recording again"),
          });
          expect(adb.wasSpawned("rm /sdcard/auto-mobile-test.mp4")).toBe(false);
          expect(adb.getCommandCount(screenrecordLivenessCommand)).toBe(attempt);
          expect(adb.getCommandCount("shell stat -c %s /sdcard/auto-mobile-test.mp4")).toBe(
            attempt * 5,
          );
        }
        expect(adb.getSpawnCalls().filter((call) => call[0] === "pull")).toHaveLength(0);
      },
    );

    test.each(["nonzero", "error", "reject"] as const)(
      "zero-byte terminal cleanup warns on rm %s and preserves the typed failure",
      async (outcome) => {
        const factory = new FakeAdbClientFactory();
        const adb = factory.getFakeClient();
        adb.setCommandResult(screenrecordLivenessCommand, "pidof-status:1\n");
        adb.setCommandResultSequence("shell stat -c %s /sdcard/auto-mobile-test.mp4", [
          "0",
          "0",
          "0",
          "0",
          "0",
        ]);
        if (outcome === "nonzero") {
          adb.setSpawnExit("shell rm ", 1);
        } else if (outcome === "error") {
          adb.setSpawnError("shell rm ", new Error("cleanup error"));
        } else {
          adb.setSpawnRejection("shell rm ", new Error("cleanup denied"));
        }
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        const captureProcess = new FakeChildProcess(timer);
        captureProcess.exitCode = 0;
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          await expect(
            new PlatformVideoCaptureBackend(factory, timer).stop(
              buildAndroidStopHandle(path.join(tempDir, "cleanup-failure.mp4"), captureProcess),
            ),
          ).rejects.toMatchObject({ retainOwnership: false });
          expect(adb.wasSpawned("rm /sdcard/auto-mobile-test.mp4")).toBe(true);
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to clean up temp file"),
          );
        } finally {
          warn.mockRestore();
        }
      },
    );

    test.each(["missing", "empty"] as const)(
      "rejects a successful pull whose host output is %s",
      async (output) => {
        const factory = new FakeAdbClientFactory();
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        const captureProcess = new FakeChildProcess(timer);
        captureProcess.exitCode = 0;
        const outputPath = path.join(tempDir, "unusable.mp4");
        if (output === "empty") {
          await writeVideoFixture(outputPath, "");
        }
        await expect(
          new PlatformVideoCaptureBackend(factory, timer).stop(
            buildAndroidStopHandle(outputPath, captureProcess),
          ),
        ).rejects.toMatchObject({
          retainOwnership: false,
          message: expect.stringContaining("no usable video"),
        });
        expect(factory.getFakeClient().wasSpawned("rm /sdcard/auto-mobile-test.mp4")).toBe(true);
      },
    );

    // issue #6291: a stop-right-after-start pull failure must not leak the raw
    // `adb pull failed with exit code N` — it should retry, then surface a
    // structured ActionableError while still cleaning up the device temp file
    // so the recording is not orphaned on-device.
    test("surfaces a genuine pull failure as an ActionableError after retrying (issue #6291)", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      fakeClient.setSpawnExit("pull", 1);
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;
      const handle = buildAndroidStopHandle(path.join(tempDir, "fail.mp4"), fakeProcess);

      let caught: unknown;
      try {
        await backend.stop(handle);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(VideoCaptureFinalizationError);
      expect((caught as Error).message).not.toBe("adb pull failed with exit code 1");
      expect((caught as Error).message).toContain("after 3 attempts");
      expect(fakeClient.getSpawnCalls().filter((call) => call[0] === "pull")).toHaveLength(3);
      expect(fakeClient.wasSpawned("rm /sdcard/auto-mobile-test.mp4")).toBe(true);
    });

    test("still removes the /sdcard temp file when the pull itself fails", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      fakeClient.setSpawnExit("pull", 1); // adb pull fails
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;
      const handle = buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess);

      await expect(backend.stop(handle)).rejects.toThrow(/adb pull failed/);

      // The finally block runs the cleanup even though the pull rejected.
      expect(fakeClient.wasSpawned("rm /sdcard/auto-mobile-test.mp4")).toBe(true);
    });

    test("preserves the pull error when cleanup cannot start", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      fakeClient.setSpawnExit("pull", 1);
      fakeClient.setSpawnRejection("rm", new Error("cleanup spawn failed"));
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess(fakeTimer);
      fakeProcess.exitCode = 0;
      const handle = buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess);

      await expect(backend.stop(handle)).rejects.toThrow(/adb pull failed/);

      expect(fakeClient.wasSpawned("rm /sdcard/auto-mobile-test.mp4")).toBe(true);
    });
  });

  describe("clampBitrateKbps", () => {
    function cfg(targetBitrateKbps: number, maxThroughputMbps: number): VideoCaptureConfig {
      return {
        recordingId: "clamp",
        outputDirectory: "/tmp",
        outputPath: "/tmp/clamp.mp4",
        fileName: "clamp.mp4",
        startedAt: new Date().toISOString(),
        qualityPreset: "low",
        targetBitrateKbps,
        maxThroughputMbps,
        fps: 15,
        maxArchiveSizeMb: 2048,
        format: "mp4",
      };
    }

    // Positive throughput has a 1 Kbps minimum; invalid non-positive throughput
    // retains the backend's existing no-cap behaviour.
    test.each([
      [5000, 2, 2000, "caps the target to the lower throughput ceiling"],
      [1000, 10, 1000, "leaves the target alone when the ceiling is higher"],
      [1000, 0, 1000, "treats a zero throughput as no cap"],
      [1000, -5, 1000, "treats a negative throughput as no cap"],
      [5000, 1, 1000, "caps at an exact 1 Mbps ceiling"],
      [10000, 0.0005, 1, "sub-1-Kbps throughput retains the minimum cap"],
      [10000, Number.MIN_VALUE, 1, "positive throughput underflow retains the minimum cap"],
      [10000, 0.001, 1, "preserves an exact 1 Kbps ceiling"],
      [10000, 0.001999, 1, "preserves flooring above the minimum"],
      [10000, 0.002, 2, "preserves the neighbouring 2 Kbps ceiling"],
    ])(
      "maps target=%p / maxMbps=%p to %p (%s)",
      (targetBitrateKbps, maxThroughputMbps, expected, _why) => {
        expect(clampBitrateKbps(cfg(targetBitrateKbps, maxThroughputMbps))).toBe(expected);
      },
    );

    test.each([false, true])(
      "spawns a capped screenrecord command (normalized=%p)",
      async (normalized) => {
        const factory = new FakeAdbClientFactory();
        const timer = new FakeTimer();
        const backend = new PlatformVideoCaptureBackend(factory, timer);
        const input = cfg(10000, 0.0005);
        await backend.start({
          ...input,
          ...(normalized ? parseVideoRecordingConfig(input) : {}),
          device: { platform: "android", deviceId: "cap-device", name: "Cap Device" },
        });
        expect(factory.getFakeClient().getSpawnCalls()).toContainEqual([
          "shell",
          "echo $$; exec screenrecord --bit-rate 1000 --time-limit 180 /sdcard/auto-mobile-clamp.mp4",
        ]);
      },
    );
  });

  describe("resolveAndroidTimeLimit", () => {
    // Bind the real private method directly: if it is renamed the bind throws,
    // rather than a self-healing `?? reimplementation` fallback keeping the test
    // green against a method that no longer exists.
    function resolve(backendInstance: PlatformVideoCaptureBackend, maxDuration?: number): number {
      return (
        backendInstance as unknown as {
          resolveAndroidTimeLimit(maxDuration?: number): number;
        }
      ).resolveAndroidTimeLimit(maxDuration);
    }

    test.each([
      [300, 180, "caps above the 180s screenrecord maximum"],
      [60, 60, "passes a sub-maximum duration through"],
      [180, 180, "keeps the exact maximum"],
      [undefined, 180, "defaults to the maximum when unspecified"],
      [0, 180, "treats zero as unspecified"],
    ])("resolves %p to %p seconds (%s)", (input, expected, _why) => {
      expect(resolve(backend, input)).toBe(expected);
    });
  });
});
