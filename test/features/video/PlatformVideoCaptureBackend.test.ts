import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { PlatformVideoCaptureBackend, clampBitrateKbps } from "../../../src/features/video/PlatformVideoCaptureBackend";
import type {
  RecordingHandle,
  VideoCaptureConfig,
} from "../../../src/features/video/VideoRecorderService";
import type { BootedDevice } from "../../../src/models";
import type { SimCtl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("PlatformVideoCaptureBackend - Unit Tests", () => {
  let backend: PlatformVideoCaptureBackend;
  let tempDir: string;

  test("gives iOS FFmpeg scaling a bounded media-processing timeout", async () => {
    let request: { timeoutMs?: number } | undefined;
    const ffmpegClient = {
      run: async (value: { timeoutMs?: number }) => {
        request = value;
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      },
    };
    const backend = new PlatformVideoCaptureBackend(
      undefined,
      undefined,
      undefined,
      ffmpegClient as any,
    );

    await (backend as any).scaleWithFfmpeg("/tmp/input.mov", "/tmp/output.mp4", { width: 1280, height: 720 });

    expect(request?.timeoutMs).toBeGreaterThan(5_000);
  });

  beforeEach(async () => {
    backend = new PlatformVideoCaptureBackend();
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "platform-video-test-"));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

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

      await expect(backend.start(configWithoutDevice)).rejects.toThrow(
        "Device is required"
      );
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

  test("starts iOS recording through the injected SimCtl argv boundary", async () => {
    const process = new FakeChildProcess();
    process.simulateSpawn();
    let receivedArgs: string[] = [];
    let receivedOptions: unknown;
    const simctl = {
      isAvailable: async () => true,
      startCommandArgs: async (args: string[], options?: unknown) => {
        receivedArgs = args;
        receivedOptions = options;
        return process as any;
      },
    } as SimCtl;
    backend = new PlatformVideoCaptureBackend(undefined, undefined, () => simctl);
    const device: BootedDevice = { platform: "ios", deviceId: "ios-platform-udid", name: "iPhone" };

    await backend.start({
      recordingId: "recording", outputDirectory: tempDir, outputPath: path.join(tempDir, "video.mp4"),
      fileName: "video.mp4", startedAt: new Date().toISOString(), qualityPreset: "low", targetBitrateKbps: 1000,
      maxThroughputMbps: 5, fps: 15, maxArchiveSizeMb: 2048, format: "mp4", device,
    });

    expect(receivedArgs).toEqual(["io", "ios-platform-udid", "recordVideo", "--codec", "h264", "--force", path.join(tempDir, "video.mp4")]);
    expect(receivedOptions).toEqual({ stdio: ["ignore", "ignore", "ignore"] });
  });

  describe("Stop Operation", () => {
    test("rejects stop when backend handle is missing", async () => {
      const invalidHandle: RecordingHandle = {
        recordingId: "test",
        outputPath: path.join(tempDir, "test.mp4"),
        startedAt: new Date().toISOString(),
        backendHandle: undefined,
      };

      await expect(backend.stop(invalidHandle)).rejects.toThrow(
        "Missing backend handle"
      );
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
    function buildAndroidStopHandle(
      outputPath: string,
      fakeProcess: FakeChildProcess
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
        exitPromise: Promise.resolve(),
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

    test("sends device-side `pkill -2 screenrecord` as the first ADB command on stop", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess();
      fakeProcess.exitCode = 0;
      const handle = buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess);

      await backend.stop(handle);

      const commands = fakeClient.getAllCommands();
      expect(commands[0]).toBe("shell pkill -2 screenrecord");
    });

    test("does NOT signal host adb when the device-side pkill caused it to exit on its own", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess();
      fakeProcess.exitCode = 0;
      const killSignals = spyOnKill(fakeProcess);

      const handle = buildAndroidStopHandle(path.join(tempDir, "out.mp4"), fakeProcess);

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
      const fakeProcess = new FakeChildProcess();
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
      fakeClient.setCommandError(
        "shell pkill -2 screenrecord",
        new Error("device offline")
      );
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess();
      // exitCode stays null → host adb still running when stop() begins
      const killSignals: Array<NodeJS.Signals | number | undefined> = [];

      let resolveExit!: () => void;
      const exitPromise = new Promise<void>(resolve => { resolveExit = resolve; });

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
      const fakeProcess = new FakeChildProcess();
      fakeProcess.exitCode = 0;

      // Simulate the pulled artifact so getFileSize returns a real byte count.
      const outputPath = path.join(tempDir, "out.mp4");
      await fsPromises.writeFile(outputPath, Buffer.alloc(4096, 1));
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

    test("still removes the /sdcard temp file when the pull itself fails", async () => {
      const fakeFactory = new FakeAdbClientFactory();
      const fakeClient = fakeFactory.getFakeClient();
      fakeClient.setSpawnExit("pull", 1); // adb pull fails
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const backend = new PlatformVideoCaptureBackend(fakeFactory, fakeTimer);
      const fakeProcess = new FakeChildProcess();
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
      const fakeProcess = new FakeChildProcess();
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

    // The throughput cap is `floor(maxThroughputMbps * 1000)` Kbps; a zero cap is
    // treated as "no cap" and the target passes through untouched.
    test.each([
      [5000, 2, 2000, "caps the target to the lower throughput ceiling"],
      [1000, 10, 1000, "leaves the target alone when the ceiling is higher"],
      [1000, 0, 1000, "treats a zero throughput as no cap"],
      [1000, -5, 1000, "treats a negative throughput as no cap"],
      [5000, 1, 1000, "caps at an exact 1 Mbps ceiling"],
      // LIVE DEFECT: floor(0.0005 * 1000) = 0 ⇒ falsy ⇒ cap silently disabled,
      // so the full 10000 Kbps target ships despite a 0.5 Kbps throughput budget.
      [10000, 0.0005, 10000, "sub-1-Kbps throughput floors to 0 and disables the cap"],
    ])(
      "maps target=%p / maxMbps=%p to %p (%s)",
      (targetBitrateKbps, maxThroughputMbps, expected, _why) => {
        expect(clampBitrateKbps(cfg(targetBitrateKbps, maxThroughputMbps))).toBe(expected);
      }
    );
  });

  describe("resolveAndroidTimeLimit", () => {
    // Bind the real private method directly: if it is renamed the bind throws,
    // rather than a self-healing `?? reimplementation` fallback keeping the test
    // green against a method that no longer exists.
    function resolve(backendInstance: PlatformVideoCaptureBackend, maxDuration?: number): number {
      return (backendInstance as unknown as {
        resolveAndroidTimeLimit(maxDuration?: number): number;
      }).resolveAndroidTimeLimit(maxDuration);
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
