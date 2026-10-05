import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BootedDevice,
  ExecutePlanResult,
  PlanExecutionOptions,
  PlanExecutionResult,
  VideoRecordingMetadata,
} from "../../src/models";
import * as planUtils from "../../src/utils/planUtils";
import { ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS } from "../../src/features/video/androidScreenrecord";
import { PlatformVideoCaptureBackend } from "../../src/features/video/PlatformVideoCaptureBackend";
import type { RecordingHandle } from "../../src/features/video/VideoRecorderService";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import {
  PlanExecutionOrchestrator,
  type PlanExecutionRequest,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import type { PlanDeviceOwnership } from "../../src/server/planDeviceOwnership";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { logger } from "../../src/utils/logger";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// #9885: a plan cancelled by a session release spent about 13.5 s in a graceful video
// stop-and-pull whose every adb call was already aborted. The review of the fix
// (#9893) added: completed segments survive, "aborted" is not "released" (only the
// session/pool ownership lookup says the device was handed back), and a discard issues
// no device-wide kill.

const FINALIZE_CAP_MS = 10_000;
const DISCARD_CAP_MS = 5_000;
const SESSION_UUID = "session-a";
const DEVICE_ID = "emulator-5554";

const config = {
  qualityPreset: "medium" as const,
  targetBitrateKbps: 1000,
  maxThroughputMbps: 1,
  fps: 30,
  maxArchiveSizeMb: 100,
  format: "mp4" as const,
};
const cancelled: PlanExecutionResult = {
  success: false,
  executedSteps: 0,
  totalSteps: 2,
  failedStep: { stepIndex: 0, tool: "observe", error: "Operation cancelled" },
};

/** A recorder whose segments land in `dir` and whose rollback drives the real Android backend. */
class FakeRecorder implements VideoRecorder {
  readonly adb = new FakeAdbClientFactory();
  readonly backend = new PlatformVideoCaptureBackend(this.adb);
  readonly stopSignals: Array<AbortSignal | undefined> = [];
  readonly handles = new Map<string, RecordingHandle>();
  private started = 0;

  constructor(private readonly dir: string) {}

  startVideoRecording = mock(async (request: { outputName?: string }) => {
    const recordingId = `rec-${this.started++}`;
    const outputPath = path.join(this.dir, `${recordingId}.mp4`);
    this.handles.set(recordingId, {
      recordingId,
      outputPath,
      startedAt: "",
      backendHandle: {
        kind: "android",
        process: new FakeChildProcess(),
        exitState: { exitCode: null, signal: null },
        exitPromise: Promise.resolve(),
        stderr: [],
        device: { platform: "android", deviceId: DEVICE_ID, name: "Emu" },
        deviceTempPath: `/sdcard/auto-mobile-${recordingId}.mp4`,
      } as never,
    });
    return {
      recordingId,
      outputPath,
      fileName: `${request.outputName}.mp4`,
      startedAt: "",
      config,
    };
  });

  stopVideoRecording = mock(async (recordingId?: string) => {
    this.stopSignals.push(getAbortSignal());
    return { metadata: this.metadata(recordingId ?? "missing"), evictedRecordingIds: [] };
  });

  rollbackVideoRecordingStart = mock(
    async (recordingId: string, options?: { deviceWide?: boolean }) => {
      await this.backend.forceStop(this.handles.get(recordingId)!, options);
    },
  );

  metadata(recordingId: string): VideoRecordingMetadata {
    return {
      recordingId,
      filePath: path.join(this.dir, `${recordingId}.mp4`),
      fileName: `${recordingId}.mp4`,
      format: "mp4",
      sizeBytes: 1,
      createdAt: "",
      startedAt: "",
      lastAccessedAt: "",
      config,
    };
  }
}

const owns = (value: boolean): PlanDeviceOwnership & { ownsDevice: ReturnType<typeof mock> } => ({
  ownsDevice: mock(() => value),
});

describe("PlanExecutionOrchestrator video teardown of a cancelled plan (#9885)", () => {
  let dir: string;
  let timer: FakeTimer;
  let caller: AbortController;
  let video: FakeRecorder;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;

  /** Two rotations (two completed segments, a third active), then the request signal aborts. */
  async function rotateTwiceThenCancel(
    ...args: Parameters<typeof planUtils.executePlan>
  ): Promise<PlanExecutionResult> {
    const options = args[7] as PlanExecutionOptions | undefined;
    for (let rotation = 0; rotation < 2; rotation++) {
      timer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS);
      await options?.onBeforePlanStep?.();
    }
    video.stopVideoRecording.mockClear();
    video.stopSignals.length = 0;
    caller.abort(new DOMException("cancelled", "AbortError"));
    return cancelled;
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "cancelled-plan-video-"));
    timer = new FakeTimer();
    caller = new AbortController();
    video = new FakeRecorder(dir);
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    execute = spyOn(planUtils, "executePlan").mockImplementation(rotateTwiceThenCancel);
  });
  afterEach(async () => {
    warn.mockRestore();
    execute.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  function orchestrator(
    platform: "android" | "ios",
    deviceOwnership: PlanDeviceOwnership,
    request: Partial<PlanExecutionRequest> = {},
    videoRecorder: VideoRecorder = video,
  ): PlanExecutionOrchestrator {
    const device: BootedDevice = { platform, deviceId: DEVICE_ID, name: "Fake" };
    return new PlanExecutionOrchestrator(
      {
        device,
        signal: caller.signal,
        request: {
          platform,
          planContent: "name: cancel\nsteps:\n  - tool: observe\n    params: {}\n",
          startStep: 0,
          deviceAllocationTimeoutMs: 5000,
          sessionUuid: SESSION_UUID,
          ...request,
        },
      },
      {
        timer,
        videoRecorder,
        deviceOwnership,
        createSchemaValidator: () => ({
          loadSchema: async () => undefined,
          validateYaml: () => ({ valid: true }),
        }),
      },
    );
  }

  /** Warnings that carry `text`: a late failure must be logged at warn exactly once. */
  const warningsAbout = (text: string) =>
    warn.mock.calls.filter(([message]) => String(message).includes(text));

  describe("the session no longer owns the device (explicit release)", () => {
    test("completed segments are returned, only the active one is discarded, and no device-wide kill runs", async () => {
      const result = await orchestrator("android", owns(false)).execute();

      // Kept: the two segments already pulled to the host, as a normal finalize returns them.
      expect(result.videoRecordingIds).toEqual(["rec-0", "rec-1"]);
      expect(result.videoFilePaths).toEqual([
        path.join(dir, "rec-0.mp4"),
        path.join(dir, "rec-1.mp4"),
      ]);
      // Discarded: only the active segment, scoped away from device-wide commands.
      expect(video.rollbackVideoRecordingStart.mock.calls).toEqual([
        ["rec-2", { deviceWide: false }],
      ]);
      // The device is not ours any more: nothing is pulled and nothing is killed device-wide.
      expect(video.stopVideoRecording).not.toHaveBeenCalled();
      const commands = video.adb.getFakeClient().getAllCommands();
      expect(commands.filter((command) => /pkill|killall|\bkill\b|pull/.test(command))).toEqual([]);
      expect(commands).toContain("shell rm -f /sdcard/auto-mobile-rec-2.mp4");
      const warnings = result.videoWarnings?.join("\n") ?? "";
      expect(warnings).toContain("device was released");
      expect(warnings).toContain("rec-2");
      expect(warnings).toContain("own time limit");
    });

    test("a plan that was never cancelled finalizes exactly as before, without consulting ownership", async () => {
      execute.mockImplementation(async () => ({ success: true, executedSteps: 1, totalSteps: 1 }));
      const ownership = owns(false);
      caller = new AbortController();

      const result = await orchestrator("android", ownership).execute();

      expect(video.stopVideoRecording).toHaveBeenCalledWith("rec-0");
      expect(video.rollbackVideoRecordingStart).not.toHaveBeenCalled();
      expect(ownership.ownsDevice).not.toHaveBeenCalled();
      expect(result.videoRecordingIds).toEqual(["rec-0"]);
    });

    test("a wedged discard releases the response after its cap, keeps completed segments, and logs the late failure once", async () => {
      const discard = Promise.withResolvers<never>();
      const finalizeWithoutDevice = spyOn(
        AndroidSegmentedPlanVideoSession.prototype,
        "finalizeWithoutDevice",
      ).mockImplementation(() => discard.promise);
      try {
        let settled: ExecutePlanResult | undefined;
        const run = orchestrator("android", owns(false))
          .execute()
          .then((result) => {
            settled = result;
          });

        await drainMicrotasks(200);
        timer.advanceTime(DISCARD_CAP_MS - 1);
        await drainMicrotasks(200);
        expect(settled).toBeUndefined();
        timer.advanceTime(1);
        await run;

        expect(settled?.videoRecordingIds).toEqual(["rec-0", "rec-1"]);
        expect(settled?.videoWarnings?.join("\n")).toContain("did not complete");
        expect(warningsAbout("device vanished")).toHaveLength(0);

        discard.reject(new Error("device vanished"));
        await drainMicrotasks(200);
        await drainMicrotasks(200);
        expect(warningsAbout("device vanished")).toHaveLength(1);
        expect(String(warningsAbout("device vanished")[0][0])).toContain("after its 5000ms cap");
      } finally {
        finalizeWithoutDevice.mockRestore();
      }
    });

    test("iOS rolls the recording back scoped to its own process instead of stopping it", async () => {
      const result = await orchestrator("ios", owns(false)).execute();

      expect(video.rollbackVideoRecordingStart).toHaveBeenCalledWith("rec-0", {
        deviceWide: false,
      });
      expect(video.stopVideoRecording).not.toHaveBeenCalled();
      expect(result.videoFilePaths).toBeUndefined();
      expect(result.videoWarnings?.join("\n")).toContain("device was released");
    });

    test("iOS without a rollback seam keeps the graceful stop", async () => {
      const bare: VideoRecorder = {
        startVideoRecording: video.startVideoRecording,
        stopVideoRecording: video.stopVideoRecording,
      };
      await orchestrator("ios", owns(false), {}, bare).execute();

      expect(video.stopVideoRecording).toHaveBeenCalledWith("rec-0");
    });

    test("an ownership lookup that throws is treated as released: no device command", async () => {
      const broken: PlanDeviceOwnership = {
        ownsDevice: () => {
          throw new Error("daemon state unavailable");
        },
      };

      await orchestrator("android", broken).execute();

      expect(video.stopVideoRecording).not.toHaveBeenCalled();
      expect(video.rollbackVideoRecordingStart).toHaveBeenCalledTimes(1);
    });
  });

  describe("the session still owns the device (deadline, client cancel)", () => {
    test("the active segment is stopped and pulled under a non-aborted shield and the video is returned with a warning", async () => {
      const ownership = owns(true);

      const result = await runWithAbortSignal(caller.signal, () =>
        orchestrator("android", ownership).execute(),
      );

      expect(ownership.ownsDevice).toHaveBeenCalledWith(SESSION_UUID, DEVICE_ID);
      // Nothing was thrown away.
      expect(video.rollbackVideoRecordingStart).not.toHaveBeenCalled();
      expect(result.videoRecordingIds).toEqual(["rec-0", "rec-1", "rec-2"]);
      // The stop ran under a signal that is neither the aborted request signal nor aborted.
      expect(video.stopVideoRecording).toHaveBeenCalledWith("rec-2");
      expect(video.stopSignals).toHaveLength(1);
      expect(video.stopSignals[0]).toBeDefined();
      expect(video.stopSignals[0]).not.toBe(caller.signal);
      expect(video.stopSignals[0]?.aborted).toBe(false);
      expect(result.videoWarnings).toContain(
        "Plan was cancelled; its video recording was finalized after cancellation",
      );
      // No fake time passed: the response did not wait on any timer.
      expect(timer.now()).toBe(2 * ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS);
    });

    test("a plan without a session id is treated as owning its device", async () => {
      const ownership = owns(false);

      const result = await orchestrator("android", ownership, {
        sessionUuid: undefined,
      }).execute();

      expect(ownership.ownsDevice).not.toHaveBeenCalled();
      expect(result.videoRecordingIds).toEqual(["rec-0", "rec-1", "rec-2"]);
    });

    test("a wedged finalize is capped at 10 s, salvages completed segments, aborts the shield, and logs its late failure once", async () => {
      const finalizing = Promise.withResolvers<never>();
      let shield: AbortSignal | undefined;
      const finalize = spyOn(
        AndroidSegmentedPlanVideoSession.prototype,
        "finalize",
      ).mockImplementation(() => {
        shield = getAbortSignal();
        return finalizing.promise;
      });
      try {
        let settled: ExecutePlanResult | undefined;
        const run = orchestrator("android", owns(true))
          .execute()
          .then((result) => {
            settled = result;
          });

        await drainMicrotasks(200);
        timer.advanceTime(FINALIZE_CAP_MS - 1);
        await drainMicrotasks(200);
        expect(settled).toBeUndefined();
        expect(shield?.aborted).toBe(false);
        timer.advanceTime(1);
        await run;

        expect(shield?.aborted).toBe(true);
        expect(settled?.videoRecordingIds).toEqual(["rec-0", "rec-1"]);
        expect(settled?.videoWarnings?.join("\n")).toContain("did not complete");
        expect(warningsAbout("adb pull failed")).toHaveLength(0);

        finalizing.reject(new Error("adb pull failed"));
        await drainMicrotasks(200);
        await drainMicrotasks(200);
        // The finalize fallback already logs a failed finalize at warn; the cap adds no duplicate.
        expect(warningsAbout("adb pull failed")).toHaveLength(1);
        expect(finalize).toHaveBeenCalledTimes(1);
      } finally {
        finalize.mockRestore();
      }
    });

    test("iOS stops the recording under the shield and returns its file", async () => {
      execute.mockImplementation(async () => {
        caller.abort();
        return cancelled;
      });

      const result = await orchestrator("ios", owns(true)).execute();

      expect(video.rollbackVideoRecordingStart).not.toHaveBeenCalled();
      expect(video.stopVideoRecording).toHaveBeenCalledWith("rec-0");
      expect(video.stopSignals[0]?.aborted).toBe(false);
      expect(result.videoRecordingIds).toEqual(["rec-0"]);
      expect(result.videoWarnings).toContain(
        "Plan was cancelled; its video recording was finalized after cancellation",
      );
    });
  });
});
