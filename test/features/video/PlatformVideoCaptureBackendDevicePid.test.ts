import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { PlatformVideoCaptureBackend } from "../../../src/features/video/PlatformVideoCaptureBackend";
import type {
  RecordingHandle,
  VideoCaptureConfig,
} from "../../../src/features/video/VideoRecorderService";
import { VideoCaptureFinalizationError } from "../../../src/features/video/VideoRecorderService";
import { logger } from "../../../src/utils/logger";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";

// Issue #9898: the recorder is stopped by its own device-side pid, never by name,
// whenever that pid is known.
const RECORDING_ID = "pid-rec";
const DEVICE_FILE = `/sdcard/auto-mobile-${RECORDING_ID}.mp4`;
const OUR_CMDLINE = `screenrecord\u0000--bit-rate\u0000100\u0000--time-limit\u0000180\u0000${DEVICE_FILE}\u0000`;
const PROBE = "shell 'cat /proc/4321/cmdline 2>/dev/null; true'";
const STAT = `shell stat -c %s ${DEVICE_FILE}`;
const PIDOF = 'shell \'pidof screenrecord; printf "pidof-status:%s\\n" "$?"\'';

describe("PlatformVideoCaptureBackend device-side recorder pid (#9898)", () => {
  let tempDir: string;
  let factory: FakeAdbClientFactory;
  let timer: FakeTimer;
  let backend: PlatformVideoCaptureBackend;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "platform-video-pid-"));
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

  async function startRecording(launchStdout?: string): Promise<RecordingHandle> {
    if (launchStdout !== undefined) {
      factory.getFakeClient().setSpawnStdout("exec screenrecord", launchStdout);
    }
    const config: VideoCaptureConfig = {
      recordingId: RECORDING_ID,
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
      device: { platform: "android", deviceId: "pid-device", name: "Pixel" },
    };
    const handle = await backend.start(config);
    // Let the buffered launch stdout reach the pid reader. A real macrotask turn rather than
    // setImmediate: start's settle probe leaves a FakeTimer dispatch immediate queued, and
    // an immediate-based flush here lost that chain, hanging the later fake sleeps.
    await defaultTimer.sleep(0);
    return handle;
  }

  function commands(): string[] {
    return factory.getFakeClient().getAllCommands();
  }

  function expectNoNameBasedKill(): void {
    expect(commands().filter((command) => /pkill|killall/.test(command))).toEqual([]);
  }

  function warnings(warn: { mock: { calls: unknown[][] } }): string {
    return warn.mock.calls.map((call) => String(call[0])).join("\n");
  }

  test("launches through a pid-reporting shell and keeps the recorder argv", async () => {
    await startRecording("4321\n");
    expect(factory.getFakeClient().getSpawnCalls()).toEqual([
      ["shell", `echo $$; exec screenrecord --bit-rate 1000000 --time-limit 180 ${DEVICE_FILE}`],
    ]);
  });

  describe("known pid", () => {
    test("stop verifies then SIGINTs only that pid, with no pkill", async () => {
      const handle = await startRecording("4321\n");
      factory.getFakeClient().setCommandResult(PROBE, OUR_CMDLINE);
      await fsPromises.writeFile(handle.outputPath, "fake-video");

      await backend.stop(handle);

      expect(commands().slice(0, 2)).toEqual([PROBE, "shell kill -2 4321"]);
      expectNoNameBasedKill();
    });

    test("forceStop verifies then SIGKILLs only that pid, with no pkill", async () => {
      const handle = await startRecording("4321\n");
      factory.getFakeClient().setCommandResult(PROBE, OUR_CMDLINE);

      await backend.forceStop(handle);

      expect(commands()).toEqual([PROBE, "shell kill -9 4321", `shell rm -f ${DEVICE_FILE}`]);
    });

    test("forceStop with deviceWide:false kills this pid and drops the may-run-on warning", async () => {
      const handle = await startRecording("4321\n");
      factory.getFakeClient().setCommandResult(PROBE, OUR_CMDLINE);
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        await backend.forceStop(handle, { deviceWide: false });

        expect(commands()).toEqual([PROBE, "shell kill -9 4321", `shell rm -f ${DEVICE_FILE}`]);
        expect(warnings(warn)).not.toContain("own time limit");
      } finally {
        warn.mockRestore();
      }
    });

    test.each([
      ["another process", "com.example.app\u0000--flag\u0000"],
      [
        "another recording's screenrecord",
        "screenrecord\u0000--time-limit\u0000180\u0000/sdcard/auto-mobile-other.mp4\u0000",
      ],
      ["a vanished or unreadable pid", ""],
    ])("forceStop does not signal a reused pid that is now %s", async (_why, cmdline) => {
      const handle = await startRecording("4321\n");
      factory.getFakeClient().setCommandResult(PROBE, cmdline);
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        await backend.forceStop(handle);

        expect(commands()).toEqual([PROBE, `shell rm -f ${DEVICE_FILE}`]);
        expect(warnings(warn)).toContain("no longer this recording's screenrecord");
      } finally {
        warn.mockRestore();
      }
    });

    test("stop does not signal a reused pid and still finalizes the recording", async () => {
      const handle = await startRecording("4321\n");
      factory.getFakeClient().setCommandResult(PROBE, "com.example.app\u0000");
      await fsPromises.writeFile(handle.outputPath, "fake-video");

      const result = await backend.stop(handle);

      expect(result.recordingId).toBe(RECORDING_ID);
      expect(commands().filter((command) => command.includes("kill"))).toEqual([]);
    });

    test("forceStop reports a failed kill as a discard failure without falling back to pkill", async () => {
      const handle = await startRecording("4321\n");
      factory.getFakeClient().setCommandResult(PROBE, OUR_CMDLINE);
      factory
        .getFakeClient()
        .setCommandError("shell kill -9 4321", new Error("operation not permitted"));

      await expect(backend.forceStop(handle)).rejects.toThrow(
        "screenrecord force-stop failed: operation not permitted",
      );
      expectNoNameBasedKill();
    });

    test("stop proceeds when the pid kill fails, without falling back to pkill", async () => {
      const handle = await startRecording("4321\n");
      factory.getFakeClient().setCommandResult(PROBE, OUR_CMDLINE);
      factory.getFakeClient().setCommandError("shell kill -2 4321", new Error("device offline"));
      await fsPromises.writeFile(handle.outputPath, "fake-video");

      await backend.stop(handle);

      expectNoNameBasedKill();
    });
  });

  // #10019: with the pid known, exit of THIS recorder is confirmed from that pid, never
  // from a device-wide pidof that an unrelated screenrecord keeps answering.
  describe("zero-byte exit confirmation by pid (#10019)", () => {
    function arrangeZeroByte(probeAnswers: string[]): void {
      const client = factory.getFakeClient();
      client.setCommandResult(STAT, "0");
      // Alive for the stop signal, then whatever the exit confirmation sees.
      client.setCommandResultSequence(PROBE, probeAnswers);
      // An unrelated recorder is running on the device.
      client.setCommandResult(PIDOF, "9999\npidof-status:0\n");
    }

    test("releases a zero-byte recording while an unrelated screenrecord runs", async () => {
      const handle = await startRecording("4321\n");
      arrangeZeroByte([OUR_CMDLINE, ""]);

      const error = await backend.stop(handle).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
      expect(error).toMatchObject({
        retainOwnership: false,
        message: expect.stringContaining("no usable video"),
      });
      expect(commands()).not.toContain(PIDOF);
      expect(commands().filter((command) => command.includes("kill"))).toEqual([
        "shell kill -2 4321",
      ]);
      expect(factory.getFakeClient().wasSpawned(`rm ${DEVICE_FILE}`)).toBe(true);
    });

    test("treats a pid reused by another process as exited", async () => {
      const handle = await startRecording("4321\n");
      arrangeZeroByte([OUR_CMDLINE, "com.example.app\u0000--flag\u0000"]);

      await expect(backend.stop(handle)).rejects.toMatchObject({ retainOwnership: false });
      expect(commands()).not.toContain(PIDOF);
    });

    test("retains the recording while its own recorder pid is still running", async () => {
      const handle = await startRecording("4321\n");
      arrangeZeroByte([OUR_CMDLINE]);

      await expect(backend.stop(handle)).rejects.toMatchObject({ retainOwnership: true });
      expect(commands()).not.toContain(PIDOF);
      expect(factory.getFakeClient().wasSpawned(`rm ${DEVICE_FILE}`)).toBe(false);
    });

    test("retains the recording when the pid probe cannot be read", async () => {
      const handle = await startRecording("4321\n");
      arrangeZeroByte([OUR_CMDLINE]);
      factory.getFakeClient().setCommandError(PROBE, new Error("device offline"));
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        await expect(backend.stop(handle)).rejects.toMatchObject({ retainOwnership: true });
        expect(warnings(warn)).toContain("Could not confirm device recorder pid 4321 exit");
      } finally {
        warn.mockRestore();
      }
    });

    test("an unknown pid still uses the device-wide pidof check", async () => {
      const handle = await startRecording("warning: something\n");
      factory.getFakeClient().setCommandResult(STAT, "0");
      factory.getFakeClient().setCommandResult(PIDOF, "9999\npidof-status:0\n");

      await expect(backend.stop(handle)).rejects.toMatchObject({ retainOwnership: true });
      expect(commands()).toContain(PIDOF);
    });
  });

  describe("unknown pid", () => {
    test.each([
      ["no launch output", undefined],
      ["a non-pid first line", "warning: something\n"],
    ])("stop keeps today's pkill -2 with %s", async (_why, stdout) => {
      const handle = await startRecording(stdout);
      await fsPromises.writeFile(handle.outputPath, "fake-video");

      await backend.stop(handle);

      expect(commands()[0]).toBe("shell pkill -2 screenrecord");
    });

    test("forceStop keeps today's pkill -9 when the caller allows device-wide", async () => {
      const handle = await startRecording();

      await backend.forceStop(handle);

      expect(commands()).toEqual(["shell pkill -9 screenrecord", `shell rm -f ${DEVICE_FILE}`]);
    });

    test("forceStop with deviceWide:false skips the device kill and warns", async () => {
      const handle = await startRecording();
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        await backend.forceStop(handle, { deviceWide: false });

        expect(commands()).toEqual([`shell rm -f ${DEVICE_FILE}`]);
        expect(warnings(warn)).toContain("device pid is unknown");
      } finally {
        warn.mockRestore();
      }
    });
  });
});
