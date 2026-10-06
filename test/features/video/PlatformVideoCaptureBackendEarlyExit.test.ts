import { beforeEach, describe, expect, test } from "bun:test";
import { PlatformVideoCaptureBackend } from "../../../src/features/video/PlatformVideoCaptureBackend";
import type {
  RecordingHandle,
  VideoCaptureConfig,
} from "../../../src/features/video/VideoRecorderService";
import { VideoCaptureFinalizationError } from "../../../src/features/video/VideoRecorderService";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import type { FakeAdbProcess } from "../../fakes/FakeAdbProcess";
import { FakeTimer } from "../../fakes/FakeTimer";

// Issue #10186: a recorder that dies is reported with its own exit code and stderr, at start
// when it dies right away and at stop when it dies later, instead of as a pull failure.
const RECORDING_ID = "early-exit";
const DEVICE_FILE = `/sdcard/auto-mobile-${RECORDING_ID}.mp4`;
const LAUNCH = "exec screenrecord";
const SETTLE_MS = 300;

describe("PlatformVideoCaptureBackend recorder exit reporting (#10186)", () => {
  let factory: FakeAdbClientFactory;
  let timer: FakeTimer;
  let backend: PlatformVideoCaptureBackend;

  beforeEach(() => {
    factory = new FakeAdbClientFactory();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    backend = new PlatformVideoCaptureBackend(factory, timer, {
      async codec() {
        return "h264";
      },
    });
  });

  function config(overrides: Partial<VideoCaptureConfig> = {}): VideoCaptureConfig {
    return {
      recordingId: RECORDING_ID,
      outputDirectory: "/nonexistent/recordings",
      outputPath: "/nonexistent/recordings/video.mp4",
      fileName: "video.mp4",
      startedAt: "1970-01-01T00:00:00.000Z",
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 100,
      format: "mp4",
      device: { platform: "android", deviceId: "early-exit-device", name: "Pixel" },
      ...overrides,
    };
  }

  /** Starts a recorder that stays alive until the test ends it. */
  async function startRunning(): Promise<{ handle: RecordingHandle; recorder: FakeAdbProcess }> {
    const client = factory.getFakeClient();
    client.setSpawnRunning(LAUNCH);
    const handle = await backend.start(config());
    return { handle, recorder: client.getSpawnedProcesses()[0] };
  }

  /** Ends the recorder the way a crash does: stderr first, then the exit event. */
  async function crash(recorder: FakeAdbProcess, code: number, stderr: string): Promise<void> {
    const delivered = new Promise<void>((resolve) => recorder.stderr.once("data", () => resolve()));
    recorder.stderr.push(stderr);
    await delivered;
    recorder.exitCode = code;
    recorder.emit("exit", code, null);
  }

  function commands(): string[] {
    return factory.getFakeClient().getAllCommands();
  }

  describe("start", () => {
    test("fails with the recorder's exit code and stderr when it exits right after spawn", async () => {
      factory.getFakeClient().setSpawnExit(LAUNCH, 1, "ERROR: unable to configure codec\n");

      const error = await backend
        .start(config({ resolution: { width: 5000, height: 5000 } }))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("code 1");
      expect(message).toContain("ERROR: unable to configure codec");
      // Classified from the tool's own output: the launch command line and the device
      // path it echoes are never part of the message.
      expect(message).not.toContain("5000x5000");
      expect(message).not.toContain(DEVICE_FILE);
      expect(factory.getFakeClient().getSpawnCalls()).toHaveLength(1);
    });

    test("fails when the recorder is killed by a signal inside the settle window", async () => {
      factory.getFakeClient().setSpawnKilled(LAUNCH, "SIGKILL");

      const error = await backend.start(config()).catch((caught: unknown) => caught);

      expect((error as Error).message).toContain("signal SIGKILL");
    });

    test("reports an aborted start as the cancellation, not as a recorder crash", async () => {
      factory.getFakeClient().setSpawnExit(LAUNCH, 1, "terminated\n");
      const controller = new AbortController();
      controller.abort();

      const error = await backend
        .start(config({ abortSignal: controller.signal }))
        .catch((caught: unknown) => caught);

      expect((error as Error).name).toBe("AbortError");
    });

    test("a recorder that stays alive through the settle window starts normally", async () => {
      const { handle, recorder } = await startRunning();

      expect(handle.recordingId).toBe(RECORDING_ID);
      expect(recorder.exitCode).toBeNull();
      expect(timer.getCurrentTime()).toBeGreaterThanOrEqual(SETTLE_MS);
    });

    test("a recorder that exits 0 inside the window is left to the stop path", async () => {
      // 0 is the recorder's own successful finish, never a launch failure.
      factory.getFakeClient().setSpawnExit(LAUNCH, 0);

      const handle = await backend.start(config());

      expect(handle.recordingId).toBe(RECORDING_ID);
    });
  });

  describe("stop", () => {
    test("reports when the recorder exited and why when it died after start returned", async () => {
      const { handle, recorder } = await startRunning();
      await crash(recorder, 1, "ERROR: encoder died\n");

      const error = await backend.stop(handle).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
      const message = (error as VideoCaptureFinalizationError).message;
      expect(message).toMatch(/recorder exited at \d{4}-\d{2}-\d{2}T\S+ with code 1/);
      expect(message).toContain("ERROR: encoder died");
      expect(message).not.toContain("pull");
      expect((error as VideoCaptureFinalizationError).retainOwnership).toBe(false);
    });

    test("skips the finalize polling and pull retries when the recorder is already gone", async () => {
      const { handle, recorder } = await startRunning();
      await crash(recorder, 1, "ERROR: encoder died\n");

      await backend.stop(handle).catch(() => undefined);

      expect(commands().filter((command) => command.includes("stat -c"))).toEqual([]);
      const spawned = factory.getFakeClient().getSpawnCalls();
      expect(spawned.some((argv) => argv[0] === "pull")).toBe(false);
      // The partial device file is still cleaned up.
      expect(spawned.some((argv) => argv.join(" ") === `shell rm ${DEVICE_FILE}`)).toBe(true);
    });

    test("a recorder that finished by its own time limit (exit 0) still goes through the pull path", async () => {
      const { handle, recorder } = await startRunning();
      recorder.exitCode = 0;
      recorder.emit("exit", 0, null);

      const error = await backend.stop(handle).catch((caught: unknown) => caught);

      expect((error as Error).message).not.toContain("before the stop was requested");
      expect(commands().some((command) => command.includes("stat -c"))).toBe(true);
    });

    test("keeps only the most recent stderr of a long-running recorder", async () => {
      const { handle, recorder } = await startRunning();
      await crash(recorder, 1, `${"x".repeat(20000)}LAST-LINE\n`);

      const error = await backend.stop(handle).catch((caught: unknown) => caught);

      const message = (error as Error).message;
      expect(message).toContain("LAST-LINE");
      expect(message.length).toBeLessThan(2000);
    });
  });
});
