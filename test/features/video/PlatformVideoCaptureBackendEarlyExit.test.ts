import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { defaultTimer } from "../../../src/utils/SystemTimer";
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
const OUR_CMDLINE = `screenrecord\u0000--bit-rate\u0000100\u0000${DEVICE_FILE}\u0000`;
const PROBE = "shell 'cat /proc/4321/cmdline 2>/dev/null; true'";
const STAT = `shell stat -c %s ${DEVICE_FILE}`;

describe("PlatformVideoCaptureBackend recorder exit reporting (#10186)", () => {
  let factory: FakeAdbClientFactory;
  let timer: FakeTimer;
  let backend: PlatformVideoCaptureBackend;
  let tempDir: string;
  let outputFile: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "platform-video-early-"));
    outputFile = path.join(tempDir, "video.mp4");
    factory = new FakeAdbClientFactory();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    backend = new PlatformVideoCaptureBackend(factory, timer, {
      async codec() {
        return "h264";
      },
    });
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
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

  /** Starts a recorder (device pid 4321) that stays alive until the test ends it. */
  async function startRunning(
    overrides: Partial<VideoCaptureConfig> = {},
  ): Promise<{ handle: RecordingHandle; recorder: FakeAdbProcess }> {
    const client = factory.getFakeClient();
    client.setSpawnRunning(LAUNCH);
    client.setSpawnStdout(LAUNCH, "4321\n");
    client.setCommandResult(PROBE, OUR_CMDLINE);
    const handle = await backend.start(config(overrides));
    // Let the buffered launch stdout reach the pid reader (a real macrotask turn, as in the
    // device-pid tests: an immediate-based flush loses the settle probe's queued dispatch).
    await defaultTimer.sleep(0);
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

    test("a crash with no file still stops the device recorder by pid, tries the pull, and cleans up", async () => {
      const { handle, recorder } = await startRunning();
      await crash(recorder, 1, "ERROR: encoder died\n");

      await backend.stop(handle).catch(() => undefined);

      // The host process dying does not prove the device recorder did: it is still signalled.
      expect(commands()).toContain("shell kill -2 4321");
      const spawned = factory.getFakeClient().getSpawnCalls();
      expect(spawned.some((argv) => argv[0] === "pull")).toBe(true);
      expect(spawned.some((argv) => argv.join(" ") === `shell rm ${DEVICE_FILE}`)).toBe(true);
    });

    test("the client-facing error does not quote the device temp path", async () => {
      const { handle, recorder } = await startRunning();
      await crash(recorder, 1, `Unable to open '${DEVICE_FILE}': No space left on device\n`);

      const error = await backend.stop(handle).catch((caught: unknown) => caught);

      const message = (error as Error).message;
      expect(message).toContain("No space left on device");
      expect(message).not.toContain(DEVICE_FILE);
    });

    test("the host adb dropping mid-recording with the device recorder alive still returns the file", async () => {
      const { handle, recorder } = await startRunning({ outputPath: outputFile });
      await crash(recorder, 1, "adb: device offline\n");
      // The device recorder is still writing, then settles at 2048 bytes.
      factory.getFakeClient().setCommandResultSequence(STAT, ["1024", "2048", "2048"]);
      await fsPromises.writeFile(outputFile, Buffer.alloc(2048, 1));

      const result = await backend.stop(handle);

      expect(commands()[1]).toBe("shell kill -2 4321");
      expect(
        factory
          .getFakeClient()
          .getSpawnCalls()
          .some((argv) => argv[0] === "pull"),
      ).toBe(true);
      expect(result.sizeBytes).toBe(2048);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("code 1");
      expect(result.warnings?.[0]).toContain("adb: device offline");
    });

    test("a retried stop pulls the retained file instead of reading its own kill as a crash", async () => {
      const { handle, recorder } = await startRunning({ outputPath: outputFile });
      // The host adb ignores the first signals and only ends when it is killed.
      recorder.kill = (signal?: NodeJS.Signals | number) => {
        recorder.killed = true;
        if (signal === "SIGKILL") {
          recorder.emit("exit", null, "SIGKILL");
        }
        return true;
      };
      // First stop: the device file keeps growing, so it is retained and ownership kept.
      factory
        .getFakeClient()
        .setCommandResultSequence(STAT, ["128", "256", "384", "512", "640", "640", "640"]);

      const first = await backend.stop(handle).catch((caught: unknown) => caught);
      expect((first as VideoCaptureFinalizationError).retainOwnership).toBe(true);
      expect((first as Error).message).toContain("retained");
      expect(
        factory
          .getFakeClient()
          .getSpawnCalls()
          .some((argv) => argv.join(" ") === `shell rm ${DEVICE_FILE}`),
      ).toBe(false);

      await fsPromises.writeFile(outputFile, Buffer.alloc(640, 1));
      const second = await backend.stop(handle);

      expect(second.sizeBytes).toBe(640);
      expect(second.warnings).toBeUndefined();
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
