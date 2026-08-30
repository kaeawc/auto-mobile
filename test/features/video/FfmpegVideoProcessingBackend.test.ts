import { beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  containsIosRecordingStartMessage,
  FfmpegVideoProcessingBackend,
  IOS_RECORDING_FILE_READY_TIMEOUT_MS,
  IOS_RECORDING_STOP_TIMEOUT_MS,
  pipeCaptureToEncoder,
  PROCESS_EXIT_TIMEOUT_MS,
  waitForExit,
  waitForRecordingFileReady,
  waitForStderrMessage,
  type ProcessTracker,
  type RecordingFileProbe,
  type StoppableProcess,
} from "../../../src/features/video/FfmpegVideoProcessingBackend";
import type { VideoCaptureConfig } from "../../../src/features/video/VideoRecorderService";
import type { BootedDevice } from "../../../src/models";
import type { SimCtl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbProcess } from "../../fakes/FakeAdbProcess";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultTimer, type Timer } from "../../../src/utils/SystemTimer";

function commandVersionAvailable(command: string): boolean {
  const result = spawnSync(command, ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

async function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    process.once("error", (error) => reject(error));
    process.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
      }
    });
  });
}

function createProcessTracker(stderr: string[] = []): ProcessTracker {
  const process = new EventEmitter() as ProcessTracker["process"];
  process.stderr = new EventEmitter() as ProcessTracker["process"]["stderr"];
  process.exitCode = null;
  process.killed = false;
  process.kill = () => true;

  return {
    process,
    exitState: {},
    exitPromise: new Promise<void>(() => {}),
    stderr,
  };
}

const hasFfmpegTools = commandVersionAvailable("ffmpeg") && commandVersionAvailable("ffprobe");

describe("FfmpegVideoProcessingBackend - Unit Tests", function () {
  let backend: FfmpegVideoProcessingBackend;
  let mockDevice: BootedDevice;
  let mockConfig: VideoCaptureConfig;
  let listEncodersCalls: number;
  let checkVersionCalls: number;

  beforeEach(function () {
    backend = new FfmpegVideoProcessingBackend();
    listEncodersCalls = 0;
    checkVersionCalls = 0;

    (backend as any).listEncoders = async () => {
      listEncodersCalls += 1;
      return ["h264_nvenc", "h264_vaapi", "h264_videotoolbox"];
    };
    (backend as any).checkFfmpegVersion = async () => {
      checkVersionCalls += 1;
    };

    mockDevice = {
      platform: "android",
      deviceId: "test-device",
      deviceType: "emulator",
      sdkVersion: 33,
      booted: true,
    } as BootedDevice;

    mockConfig = {
      recordingId: "test-recording",
      outputDirectory: "/tmp/test",
      outputPath: "/tmp/test/video.mp4",
      fileName: "video.mp4",
      startedAt: new Date().toISOString(),
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 2048,
      format: "mp4",
      device: mockDevice,
    };
  });

  test("starts iOS recording through the injected SimCtl argv boundary", async function () {
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stderr, stdout: null, stdin: null, killed: false, kill: () => true });
    let receivedArgs: string[] = [];
    let receivedOptions: SpawnOptions | undefined;
    const simctl = {
      isAvailable: async () => true,
      startCommandArgs: async (args: string[], options?: SpawnOptions) => {
        receivedArgs = args;
        receivedOptions = options;
        defaultTimer.setTimeout(() => {
          child.emit("spawn");
          stderr.write("Recording started\n");
        }, 0);
        return child;
      },
    } as SimCtl;
    backend = new FfmpegVideoProcessingBackend(undefined, () => simctl);
    (backend as any).ensureFfmpegAvailable = async () => {};
    mockConfig.device = { ...mockDevice, platform: "ios", deviceId: "ios-recording-udid" };

    await backend.start(mockConfig);

    expect(receivedArgs).toEqual([
      "io",
      "ios-recording-udid",
      "recordVideo",
      path.join(mockConfig.outputDirectory, "test-recording-raw.mov"),
    ]);
    expect(receivedOptions).toEqual({ stdio: ["ignore", "ignore", "pipe"] });
  });

  // A fake capture process: emits "spawn" then, when asked, the recordVideo start
  // handshake. kill() emits "exit" so waitForExit's SIGINT teardown resolves.
  function makeCaptureChild(emitHandshake: boolean, timer: Timer = defaultTimer): ChildProcess {
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stderr,
      stdout: null,
      stdin: null,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: () => {
        (child as unknown as { killed: boolean }).killed = true;
        queueMicrotask(() => child.emit("exit", 0, "SIGINT"));
        return true;
      },
    });
    timer.setTimeout(() => {
      child.emit("spawn");
      if (emitHandshake) {
        stderr.write("Recording started\n");
      }
    }, 0);
    return child;
  }

  function diagnosticsExecResult(state: string) {
    return {
      stdout: state,
      stderr: "",
      toString: () => state,
      trim: () => state,
      includes: (s: string) => state.includes(s),
    };
  }

  test("retries the iOS recording start handshake and succeeds on a later attempt (#4076)", async function () {
    const started: ChildProcess[] = [];
    let diagnosticCalls = 0;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const simctl = {
      isAvailable: async () => true,
      // First attempt never emits the handshake (cold-simulator miss); the retry does.
      startCommandArgs: async () => {
        const child = makeCaptureChild(started.length >= 1, timer);
        started.push(child);
        return child;
      },
      executeCommandArgs: async () => {
        diagnosticCalls++;
        return diagnosticsExecResult("iPhone 17 Pro (udid) (Booted)");
      },
    } as unknown as SimCtl;

    backend = new FfmpegVideoProcessingBackend(
      undefined,
      () => simctl,
      undefined,
      undefined,
      undefined,
      timer,
    );
    (backend as any).ensureFfmpegAvailable = async () => {};
    (backend as any).iosRecordingStartTimeoutMs = 25;
    mockConfig.device = { ...mockDevice, platform: "ios", deviceId: "ios-retry-udid" };

    const handle = await backend.start(mockConfig);

    expect(handle.recordingId).toBe("test-recording");
    expect(started.length).toBe(2); // one retry after the first miss
    expect(diagnosticCalls).toBe(1); // diagnostics captured once, on the miss
  });

  test("kills an iOS recorder that is still waiting for its start handshake when shutdown aborts", async function () {
    const child = makeCaptureChild(false);
    const controller = new AbortController();
    let markStartRequested: (() => void) | undefined;
    const startRequested = new Promise<void>((resolve) => {
      markStartRequested = resolve;
    });
    const simctl = {
      isAvailable: async () => true,
      startCommandArgs: async () => {
        markStartRequested?.();
        return child;
      },
    } as unknown as SimCtl;
    backend = new FfmpegVideoProcessingBackend(undefined, () => simctl);
    (backend as any).ensureFfmpegAvailable = async () => {};
    mockConfig.device = { ...mockDevice, platform: "ios", deviceId: "ios-abort-udid" };
    mockConfig.abortSignal = controller.signal;

    const starting = backend.start(mockConfig);
    await startRequested;
    controller.abort();

    await expect(starting).rejects.toThrow("cancelled during shutdown");
    expect(child.killed).toBe(true);
  });

  test("kills an Android FFmpeg-pipe recorder that is still starting when shutdown aborts", async function () {
    const captureProcess = new FakeAdbProcess();
    let resolveCaptureSpawned: (() => void) | undefined;
    const captureSpawned = new Promise<void>((resolve) => {
      resolveCaptureSpawned = resolve;
    });
    const adb = {
      spawn: async () => {
        resolveCaptureSpawned?.();
        return captureProcess;
      },
    } as unknown as AdbExecutor;
    const controller = new AbortController();
    backend = new FfmpegVideoProcessingBackend(new FakeAdbClientFactory(adb));
    (backend as any).ensureFfmpegAvailable = async () => {};
    (backend as any).detectHardwareAccel = async () => await new Promise<void>(() => {});
    mockConfig.device = { ...mockDevice, platform: "android", deviceId: "android-abort-serial" };
    mockConfig.abortSignal = controller.signal;

    const starting = backend.start(mockConfig);
    void starting.catch(() => undefined);
    await captureSpawned;
    controller.abort();
    await Promise.resolve();

    expect(captureProcess.killed).toBe(true);
  });

  test("fails after exhausting start attempts and reports simulator diagnostics (#4076)", async function () {
    let starts = 0;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const simctl = {
      isAvailable: async () => true,
      startCommandArgs: async () => {
        starts++;
        return makeCaptureChild(false, timer); // never emits the handshake
      },
      executeCommandArgs: async () => diagnosticsExecResult("iPhone 17 Pro (udid) (Shutdown)"),
    } as unknown as SimCtl;

    backend = new FfmpegVideoProcessingBackend(
      undefined,
      () => simctl,
      undefined,
      undefined,
      undefined,
      timer,
    );
    (backend as any).ensureFfmpegAvailable = async () => {};
    (backend as any).iosRecordingStartTimeoutMs = 25;
    mockConfig.device = { ...mockDevice, platform: "ios", deviceId: "ios-wedge-udid" };

    let error: Error | undefined;
    try {
      await backend.start(mockConfig);
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain("after 2 attempt(s)");
    expect(error!.message).toContain("simulator state");
    expect(error!.message).toContain("Shutdown");
    expect(starts).toBe(2); // exhausted the bounded retry budget
  });

  test("fails and reaps a slow iOS start within the five-second total budget", async function () {
    const timer = new FakeTimer();
    const stderr = new PassThrough();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stderr,
      stdout: null,
      stdin: null,
      killed: false,
      exitCode: null,
      signalCode: null,
      pid: 123,
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        (child as unknown as { killed: boolean }).killed = true;
        queueMicrotask(() => child.emit("exit", null, signal));
        return true;
      },
    });
    const simctl = {
      isAvailable: async () => true,
      startCommandArgs: async () => child,
      executeCommandArgs: async () => diagnosticsExecResult("Booted"),
    } as unknown as SimCtl;
    backend = new FfmpegVideoProcessingBackend(
      undefined,
      () => simctl,
      undefined,
      undefined,
      undefined,
      timer,
    );
    (backend as any).ensureFfmpegAvailable = async () => {};
    (backend as any).iosRecordingStartMaxAttempts = 1;
    mockConfig.device = { ...mockDevice, platform: "ios", deviceId: "ios-slow-udid" };

    const starting = backend.start(mockConfig);
    for (let i = 0; i < 20 && !timer.getPendingTimeouts().includes(4500); i++) {
      await Promise.resolve();
    }
    expect(timer.getPendingTimeouts()).toEqual([4500]);

    timer.advanceTime(4500);
    await expect(starting).rejects.toThrow("Failed to start iOS recording");

    expect(timer.now()).toBeLessThanOrEqual(5000);
    expect(signals).toEqual(["SIGKILL"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  test("shares one successful FFmpeg capability probe across availability and encoder checks", async function () {
    let probeCalls = 0;
    const ffmpegClient = {
      binaryPath: "ffmpeg",
      async probe() {
        probeCalls++;
        return { version: "7.1", encoders: ["h264_videotoolbox"] };
      },
    };
    const scoped = new FfmpegVideoProcessingBackend(
      undefined,
      undefined,
      ffmpegClient as any,
      () => "darwin",
    );

    await (scoped as any).ensureFfmpegAvailable();
    await (scoped as any).detectHardwareAccel();

    expect(probeCalls).toBe(1);
  });

  describe("Hardware Acceleration Detection", function () {
    // The injected platform provider lets every OS branch be verified on any
    // host, instead of only the one matching the CI runner. listEncoders is
    // stubbed in beforeEach to advertise all three hardware encoders, so each
    // platform selects its own preferred encoder.
    function backendForPlatform(os: NodeJS.Platform): FfmpegVideoProcessingBackend {
      const scoped = new FfmpegVideoProcessingBackend(undefined, undefined, undefined, () => os);
      (scoped as any).listEncoders = async () => {
        listEncodersCalls += 1;
        return ["h264_nvenc", "h264_vaapi", "h264_videotoolbox"];
      };
      return scoped;
    }

    test.each([
      ["darwin", "h264_videotoolbox", true],
      ["linux", "h264_nvenc", true],
      ["win32", "libx264", false],
    ])("selects the %s hardware encoder", async (os, encoder, available) => {
      const hwAccel = await (
        backendForPlatform(os as NodeJS.Platform) as any
      ).detectHardwareAccel();
      expect(hwAccel.encoder).toBe(encoder);
      expect(hwAccel.available).toBe(available);
    });

    test("caches the detection result so encoders are probed at most once", async function () {
      // Unconditional assertion (not gated on host platform): a darwin backend
      // probes exactly once across two detect calls.
      const scoped = backendForPlatform("darwin");
      listEncodersCalls = 0;

      const first = await (scoped as any).detectHardwareAccel();
      const second = await (scoped as any).detectHardwareAccel();

      expect(first).toEqual(second);
      expect(listEncodersCalls).toBe(1);
    });
  });

  describe("FFmpeg Args Builder", function () {
    test("should build basic FFmpeg args for piped input", async function () {
      const hwAccel = {
        encoder: "libx264",
        available: false,
        description: "Software encoding",
      };

      const args = await (backend as any).buildFfmpegArgs(mockConfig, hwAccel, { type: "pipe" });

      expect(args).toContain("-f");
      expect(args).toContain("mp4");
      expect(args).toContain("-i");
      expect(args).toContain("pipe:0");
      expect(args).toContain("-r");
      expect(args).toContain("15");
      expect(args).toContain("-b:v");
      expect(args).toContain("1000k");
      expect(args).toContain("-c:v");
      expect(args).toContain("libx264");
      expect(args).toContain(mockConfig.outputPath);
    });

    test("should include resolution scaling when specified", async function () {
      const configWithResolution = {
        ...mockConfig,
        resolution: { width: 1280, height: 720 },
      };

      const hwAccel = {
        encoder: "libx264",
        available: false,
        description: "Software encoding",
      };

      const args = await (backend as any).buildFfmpegArgs(configWithResolution, hwAccel, {
        type: "pipe",
      });

      expect(args).toContain("-vf");
      expect(args).toContain("scale=1280:720");
    });

    test("should use hardware encoder when available", async function () {
      const hwAccel = {
        encoder: "h264_videotoolbox",
        available: true,
        description: "VideoToolbox HW accel",
      };

      const args = await (backend as any).buildFfmpegArgs(mockConfig, hwAccel, { type: "pipe" });

      expect(args).toContain("-c:v");
      expect(args).toContain("h264_videotoolbox");
      expect(args).not.toContain("-preset");
    });

    test("should include duration limit when specified", async function () {
      const configWithDuration = {
        ...mockConfig,
        maxDurationSeconds: 60,
      };

      const hwAccel = {
        encoder: "libx264",
        available: false,
        description: "Software encoding",
      };

      const args = await (backend as any).buildFfmpegArgs(configWithDuration, hwAccel, {
        type: "pipe",
      });

      expect(args).toContain("-t");
      expect(args).toContain("60");
    });

    test("should remux iOS simulator file input without re-encoding when no scaling is requested", async function () {
      const hwAccel = {
        encoder: "h264_videotoolbox",
        available: true,
        description: "VideoToolbox HW accel",
      };

      const args = await (backend as any).buildFfmpegArgs(mockConfig, hwAccel, {
        type: "file",
        path: "/tmp/test/test-recording-raw.mov",
      });

      expect(args).toEqual([
        "-i",
        "/tmp/test/test-recording-raw.mov",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-y",
        mockConfig.outputPath,
      ]);
    });

    test("should trim unscaled iOS simulator file input while preserving stream-copy remux", async function () {
      const hwAccel = {
        encoder: "h264_videotoolbox",
        available: true,
        description: "VideoToolbox HW accel",
      };

      const args = await (backend as any).buildFfmpegArgs(
        {
          ...mockConfig,
          maxDurationSeconds: 1,
        },
        hwAccel,
        { type: "file", path: "/tmp/test/test-recording-raw.mov" },
      );

      expect(args).toEqual([
        "-i",
        "/tmp/test/test-recording-raw.mov",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-t",
        "1",
        "-y",
        mockConfig.outputPath,
      ]);
    });

    (hasFfmpegTools ? test : test.skip)(
      "should produce playable trimmed output when stream-copy remuxing unscaled iOS input",
      async function () {
        const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-remux-"));
        const rawPath = path.join(tempDir, "raw.mov");
        const outputPath = path.join(tempDir, "trimmed.mp4");

        try {
          await runCommand("ffmpeg", [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=16x16:rate=5",
            "-t",
            "2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            rawPath,
          ]);

          const args = await (backend as any).buildFfmpegArgs(
            {
              ...mockConfig,
              outputPath,
              maxDurationSeconds: 1,
            },
            {
              encoder: "libx264",
              available: false,
              description: "Software encoding",
            },
            { type: "file", path: rawPath },
          );

          await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args]);

          const stats = await fsPromises.stat(outputPath);
          expect(stats.size).toBeGreaterThan(0);

          const probe = await runCommand("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            outputPath,
          ]);
          const durationSeconds = Number.parseFloat(probe.stdout.trim());
          expect(durationSeconds).toBeGreaterThan(0);
          expect(durationSeconds).toBeLessThan(1.6);
        } finally {
          await fsPromises.rm(tempDir, { recursive: true, force: true });
        }
      },
    );

    test("should transcode file input when scaling is requested", async function () {
      const hwAccel = {
        encoder: "h264_videotoolbox",
        available: true,
        description: "VideoToolbox HW accel",
      };

      const args = await (backend as any).buildFfmpegArgs(
        {
          ...mockConfig,
          resolution: { width: 720, height: 1280 },
        },
        hwAccel,
        { type: "file", path: "/tmp/test/test-recording-raw.mov" },
      );

      expect(args).toContain("-vf");
      expect(args).toContain("scale=720:1280");
      expect(args).toContain("-c:v");
      expect(args).toContain("h264_videotoolbox");
    });
  });

  describe("FFmpeg Diagnostics", function () {
    test("should require simctl's first-frame signal before reporting iOS recording startup", function () {
      expect(
        containsIosRecordingStartMessage(
          "Note: No display specified. Defaulting to display: 4FCB34AC-FD7C-4A7E-9A19-CB10950490D8 (screenID: 1, name: LCD)\n",
        ),
      ).toBe(false);
      expect(containsIosRecordingStartMessage("Recording started\n")).toBe(true);
      expect(containsIosRecordingStartMessage("Unable to boot simulator\n")).toBe(false);
    });

    test("should resolve when stderr captured the expected message without another data event", async function () {
      const tracker = createProcessTracker();
      const wait = waitForStderrMessage(tracker, "Recording started", 1);
      tracker.stderr.push("Note: No display specified\nRecording started\n");

      await expect(wait).resolves.toBeUndefined();
    });

    test("should reject when expected stderr message never appears", async function () {
      const tracker = createProcessTracker(["No display yet\n"]);

      await expect(waitForStderrMessage(tracker, "Recording started", 1)).rejects.toThrow(
        /Timed out waiting for Recording started/,
      );
    });

    test("fails immediately when the tracked process exited before listeners attach", async function () {
      const timer = new FakeTimer();
      const tracker = createProcessTracker();
      tracker.exitState.endedAt = new Date().toISOString();
      tracker.process.exitCode = 1;

      await expect(
        waitForStderrMessage(tracker, "Recording started", 5000, { timer }),
      ).rejects.toThrow("Process exited before Recording started");
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    test("abort removes handshake listeners and its timeout", async function () {
      const timer = new FakeTimer();
      const tracker = createProcessTracker();
      const controller = new AbortController();
      const stderr = tracker.process.stderr as unknown as EventEmitter;
      const waiting = waitForStderrMessage(tracker, "Recording started", 5000, {
        timer,
        signal: controller.signal,
      });

      expect(timer.getPendingTimeoutCount()).toBe(1);
      expect(stderr.listenerCount("data")).toBe(1);
      controller.abort(new Error("cancelled"));

      await expect(waiting).rejects.toThrow("cancelled");
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(stderr.listenerCount("data")).toBe(0);
      const processEmitter = tracker.process as unknown as EventEmitter;
      expect(processEmitter.listenerCount("exit")).toBe(0);
      expect(processEmitter.listenerCount("error")).toBe(0);
    });

    test("should include command, stderr, and missing output path for opaque post-processing failures", function () {
      const message = (backend as any).buildFfmpegFailureMessage(
        "FFmpeg output file missing",
        ["-i", "/tmp/raw.mov", "-c", "copy", "-y", "/tmp/out.mp4"],
        {
          exitState: { exitCode: null, signal: "SIGINT" },
          stderr: ["moov atom not found\n"],
        },
        "/tmp/out.mp4",
      );

      expect(message).toContain("FFmpeg output file missing");
      expect(message).toContain("output: /tmp/out.mp4");
      expect(message).toContain("command: ffmpeg -i /tmp/raw.mov -c copy -y /tmp/out.mp4");
      expect(message).toContain("exitCode: null");
      expect(message).toContain("signal: SIGINT");
      expect(message).toContain("stderr:\nmoov atom not found");
    });

    test("should include command and stderr for non-zero exits", function () {
      const message = (backend as any).buildFfmpegFailureMessage(
        "FFmpeg post-processing failed",
        ["-i", "/tmp/raw.mov", "-y", "/tmp/out.mp4"],
        {
          exitState: { exitCode: 1, signal: null },
          stderr: ["Invalid argument\n"],
        },
      );

      expect(message).toContain("FFmpeg post-processing failed");
      expect(message).toContain("command: ffmpeg -i /tmp/raw.mov -y /tmp/out.mp4");
      expect(message).toContain("exitCode: 1");
      expect(message).toContain("stderr:\nInvalid argument");
    });

    test("should reject missing post-processed output with FFmpeg context", async function () {
      const outputPath = path.join(os.tmpdir(), "auto-mobile-missing-output.mp4");

      await expect(
        (backend as any).assertFfmpegOutputReady(
          outputPath,
          ["-i", "/tmp/raw.mov", "-c", "copy", "-y", outputPath],
          {
            exitState: { exitCode: 0, signal: null },
            stderr: ["No output produced\n"],
          },
        ),
      ).rejects.toThrow(/FFmpeg output file missing/);
    });

    test("should reject empty post-processed output with FFmpeg context", async function () {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-video-"));
      const outputPath = path.join(tempDir, "empty.mp4");

      try {
        await fsPromises.writeFile(outputPath, "");

        await expect(
          (backend as any).assertFfmpegOutputReady(
            outputPath,
            ["-i", "/tmp/raw.mov", "-c", "copy", "-y", outputPath],
            {
              exitState: { exitCode: 0, signal: null },
              stderr: [],
            },
          ),
        ).rejects.toThrow(/FFmpeg output file is empty/);
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("FFmpeg Availability", function () {
    test("should check FFmpeg version", async function () {
      await (backend as any).checkFfmpegVersion();
      expect(checkVersionCalls).toBe(1);
    });
  });

  describe("Encoder Listing", function () {
    test("should list available encoders", async function () {
      const encoders = await (backend as any).listEncoders();
      expect(Array.isArray(encoders)).toBe(true);
      expect(encoders.length).toBeGreaterThan(0);
      expect(listEncodersCalls).toBe(1);
    });
  });
});

interface FakeProcessControl {
  process: StoppableProcess;
  exitPromise: Promise<void>;
  killSignals: Array<NodeJS.Signals | number>;
  exit: (code?: number) => void;
}

/**
 * A fake capture process that records which signals it received. It only exits
 * when the test explicitly calls `exit()` or when it is sent SIGKILL — mirroring
 * a real `simctl recordVideo` process that ignores everything but SIGINT (which
 * triggers a flush) and SIGKILL (which terminates immediately).
 */
function createFakeProcess(): FakeProcessControl {
  const killSignals: Array<NodeJS.Signals | number> = [];
  let resolveExit: () => void = () => {};
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const exit = (code = 0): void => {
    if (process.exitCode !== null) {
      return;
    }
    process.exitCode = code;
    resolveExit();
  };

  const process: StoppableProcess = {
    exitCode: null,
    killed: false,
    kill(signal?: NodeJS.Signals | number): boolean {
      killSignals.push(signal ?? "SIGTERM");
      process.killed = true;
      if (signal === "SIGKILL") {
        exit(137);
      }
      return true;
    },
  };

  return { process, exitPromise, killSignals, exit };
}

describe("waitForExit - graceful capture stop", function () {
  test("sends SIGINT and returns without SIGKILL when the process flushes in time", async function () {
    const timer = new FakeTimer();
    const { process, exitPromise, killSignals, exit } = createFakeProcess();

    const pending = waitForExit(process, exitPromise, {
      timeoutMs: IOS_RECORDING_STOP_TIMEOUT_MS,
      timer,
    });

    // SIGINT is delivered synchronously so simctl can begin flushing the moov atom.
    expect(killSignals).toEqual(["SIGINT"]);

    // simctl takes 8s to write the file under load — well within the iOS window.
    timer.advanceTime(8000);
    await Promise.resolve();
    expect(killSignals).toEqual(["SIGINT"]);

    exit(0);
    await pending;

    // No SIGKILL: the file was allowed to finalize cleanly.
    expect(killSignals).toEqual(["SIGINT"]);
  });

  test("escalates to SIGKILL once the timeout elapses", async function () {
    const timer = new FakeTimer();
    const { process, exitPromise, killSignals } = createFakeProcess();

    const pending = waitForExit(process, exitPromise, {
      timeoutMs: PROCESS_EXIT_TIMEOUT_MS,
      timer,
    });

    expect(killSignals).toEqual(["SIGINT"]);

    // Just before the deadline the process is still given a chance to exit cleanly.
    timer.advanceTime(PROCESS_EXIT_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(killSignals).toEqual(["SIGINT"]);

    // After the deadline it is force-killed so the caller never hangs.
    timer.advanceTime(1);
    await pending;
    expect(killSignals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("the legacy 5s window would SIGKILL a slow simctl flush that the iOS window survives", async function () {
    const slowFlushMs = 8000;

    // Legacy generic timeout: the same slow flush is force-killed mid-write.
    const legacyTimer = new FakeTimer();
    const legacy = createFakeProcess();
    const legacyPending = waitForExit(legacy.process, legacy.exitPromise, {
      timeoutMs: PROCESS_EXIT_TIMEOUT_MS,
      timer: legacyTimer,
    });
    legacyTimer.advanceTime(slowFlushMs);
    await legacyPending;
    expect(legacy.killSignals).toEqual(["SIGINT", "SIGKILL"]);

    // iOS window: the slow flush completes and the process exits via SIGINT only.
    const iosTimer = new FakeTimer();
    const ios = createFakeProcess();
    const iosPending = waitForExit(ios.process, ios.exitPromise, {
      timeoutMs: IOS_RECORDING_STOP_TIMEOUT_MS,
      timer: iosTimer,
    });
    iosTimer.advanceTime(slowFlushMs);
    await Promise.resolve();
    ios.exit(0);
    await iosPending;
    expect(ios.killSignals).toEqual(["SIGINT"]);
  });

  test("iOS stop window is generous enough for a moov-atom flush under load", function () {
    expect(IOS_RECORDING_STOP_TIMEOUT_MS).toBeGreaterThan(PROCESS_EXIT_TIMEOUT_MS);
    expect(IOS_RECORDING_STOP_TIMEOUT_MS).toBeGreaterThanOrEqual(30000);
  });
});

/**
 * A fake filesystem probe that replays a scripted sequence of observed sizes.
 * `null` models a not-yet-visible file; once the script is exhausted the last
 * value repeats. Mirrors a real `simctl recordVideo` output that appears late
 * and grows before its moov-atom flush finalizes it on a loaded runner.
 */
function scriptedProbe(sizes: Array<number | null>): {
  probe: RecordingFileProbe;
  calls: () => number;
} {
  let index = 0;
  const probe: RecordingFileProbe = {
    async size(): Promise<number | null> {
      const value = sizes[Math.min(index, sizes.length - 1)];
      index++;
      return value ?? null;
    },
  };
  return { probe, calls: () => index };
}

describe("waitForRecordingFileReady - post-exit file finalization", function () {
  test("returns the size once a late file appears and stabilizes", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    // Missing for the first two probes (flush lag), then a stable non-empty file.
    const { probe, calls } = scriptedProbe([null, null, 2048, 2048]);

    const size = await waitForRecordingFileReady("/tmp/rec-raw.mov", {
      probe,
      timer,
      timeoutMs: 5000,
      backoff: 100,
    });

    expect(size).toBe(2048);
    expect(calls()).toBe(4);
  });

  test("waits for a growing file to stop changing before returning", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    // File appears then grows across probes; only the stabilized size is accepted.
    const { probe } = scriptedProbe([512, 4096, 4096]);

    const size = await waitForRecordingFileReady("/tmp/rec-raw.mov", {
      probe,
      timer,
      timeoutMs: 5000,
      backoff: 100,
    });

    // Never returns the intermediate 512-byte read.
    expect(size).toBe(4096);
  });

  test("throws a 'never appeared' diagnostic when the file is always missing", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { probe, calls } = scriptedProbe([null]);

    let thrown: unknown;
    try {
      await waitForRecordingFileReady("/tmp/rec-raw.mov", {
        probe,
        timer,
        timeoutMs: 1000,
        backoff: 100,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("never appeared");
    expect((thrown as Error).message).toContain("/tmp/rec-raw.mov");
    // Bounded: it stopped polling instead of hanging.
    expect(calls()).toBeGreaterThan(0);
  });

  test("throws a 'disappeared after appearing' diagnostic when a file vanishes and never returns", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    // File shows up with bytes, then vanishes (e.g. simctl cleanup on error) and never comes back.
    const { probe } = scriptedProbe([1024, null]);

    let thrown: unknown;
    try {
      await waitForRecordingFileReady("/tmp/rec-raw.mov", {
        probe,
        timer,
        timeoutMs: 1000,
        backoff: 100,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("disappeared after appearing");
  });

  test("throws a 'stayed empty' diagnostic when the file never gets bytes", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { probe } = scriptedProbe([0]);

    let thrown: unknown;
    try {
      await waitForRecordingFileReady("/tmp/rec-raw.mov", {
        probe,
        timer,
        timeoutMs: 1000,
        backoff: 100,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("stayed empty (0 bytes)");
  });

  test("the readiness window is generous but not unbounded", function () {
    expect(IOS_RECORDING_FILE_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    expect(IOS_RECORDING_FILE_READY_TIMEOUT_MS).toBeLessThanOrEqual(IOS_RECORDING_STOP_TIMEOUT_MS);
  });
});

describe("pipeCaptureToEncoder", function () {
  test("registers an error handler on the encoder stdin so EPIPE is not unhandled", function () {
    const source = new PassThrough();
    const dest = new PassThrough();
    pipeCaptureToEncoder(source, dest);

    // A Node stream/EventEmitter with no 'error' listener rethrows on emit.
    // The helper must have attached one, so the mid-recording encoder-death
    // EPIPE is swallowed instead of crashing the daemon.
    expect(() => dest.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(() => source.emit("error", new Error("EPIPE"))).not.toThrow();
  });

  test("throws a clear error when either stream is unavailable", function () {
    expect(() => pipeCaptureToEncoder(null, new PassThrough())).toThrow(/unavailable/);
    expect(() => pipeCaptureToEncoder(new PassThrough(), null)).toThrow(/unavailable/);
  });

  test("still forwards capture bytes into the encoder", async function () {
    const source = new PassThrough();
    const dest = new PassThrough();
    pipeCaptureToEncoder(source, dest);

    const chunks: Buffer[] = [];
    dest.on("data", (chunk) => chunks.push(chunk as Buffer));
    source.write("frame-data");
    source.end();
    await new Promise<void>((resolve) => dest.on("end", () => resolve()));

    expect(Buffer.concat(chunks).toString()).toBe("frame-data");
  });
});
