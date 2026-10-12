import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, PlanStep } from "../../src/models";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { VideoRecorderService } from "../../src/features/video";
import {
  defaultRecordingSessionCleanupDeps,
  registerRecordingSessionCleanup,
  takeRecordingIdsFinalizedByRelease,
  type RecordingSessionCleanupDeps,
} from "../../src/server/recordingSessionCleanup";
import {
  getDeviceGestureRecordingStatus,
  isDeviceGestureRecordingOwnedBy,
  resetStoppedDeviceGestureRecordings,
  startDeviceGestureRecording,
  stopDeviceGestureRecording,
} from "../../src/server/deviceGestureRecordingManager";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";

type CleanupManager = Parameters<typeof registerRecordingSessionCleanup>[0];
type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const step: PlanStep = { tool: "tapOn", params: { text: "OK" } };
const OLD_HOLDER = "session-a";
const NEW_HOLDER = "session-b";

class FakeSessionManager implements CleanupManager {
  releaseCallbacks: ReleaseCallback[] = [];
  pendingCleanups: Array<Promise<unknown>> = [];

  onSessionRelease(callback: ReleaseCallback): void {
    this.releaseCallbacks.push(callback);
  }
  onSessionDeviceUnbound(): void {}
  registerPendingDeviceCleanup(_deviceId: string, cleanup: Promise<unknown>): void {
    this.pendingCleanups.push(cleanup);
  }
  release(sessionId: string, deviceId: string): void {
    for (const callback of this.releaseCallbacks) {
      callback(
        sessionId,
        deviceId,
        "idle-timeout",
        {
          sessionId,
          deviceId,
          releaseReason: "idle-timeout",
          releasedAtMs: 0,
          terminal: true,
          heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
        },
        {},
      );
    }
  }
}

/**
 * "A recording stops and finalizes when its session is released, capped at about 120 s"
 * (docs/using/device-ownership.md), and the cap covers EVERY recording the owner has: single-file,
 * segmented and the device gesture recording (#11041). recordingSessionCleanup.test.ts pins that with a fake
 * whose `markVideoRecordingIncomplete` accepts any id.
 *
 * The real one (`markVideoRecordingIncomplete` in src/server/videoRecordingManager.ts) only knows
 * video recordings: handed the device gesture recording's id it force-stops nothing and finds no row. The
 * device gesture recording is stopped only by the last stage of `stopOwnedRecordings`, which a wedged
 * earlier stage never reaches. So at the cap the device is freed with the released session's
 * recorder still capturing, still owned by the ended session, and the next holder's `start` joins
 * it: the new holder's session is recorded into the old holder's recording.
 */
describe("finalize cap with a wedged video stage and the released session's device gesture recording", () => {
  let timer: FakeTimer;
  let recorderStops: number;

  beforeEach(async () => {
    timer = new FakeTimer();
    recorderStops = 0;
    resetStoppedDeviceGestureRecordings();
    await setVideoRecordingManagerDependencies({
      videoRecorderService: new VideoRecorderService({
        backend: new FakeVideoCaptureBackend(),
        idGenerator: new FakeIdGenerator(),
        archiveRoot: "/nonexistent/auto-mobile-hunt-finalize-cap",
        now: () => new Date(timer.now()),
      }),
      recordingRepository: new FakeVideoRecordingRepository(),
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer,
      now: () => new Date(timer.now()),
    });
  });

  afterEach(async () => {
    // Module state: stop whatever the scenario left running.
    await stopDeviceGestureRecording(undefined, undefined, timer).catch(() => undefined);
    takeRecordingIdsFinalizedByRelease(OLD_HOLDER);
    resetVideoRecordingManagerDependencies();
  });

  const recorder = () => ({
    stepCount: 0,
    start: async () => undefined,
    stop: async () => {
      recorderStops += 1;
      return { steps: [step], stepCount: 1 };
    },
  });

  const releaseWithWedgedVideoStage = async (): Promise<string> => {
    const started = await startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator("recording"),
      recorder,
      OLD_HOLDER,
    );
    const manager = new FakeSessionManager();
    const deps: RecordingSessionCleanupDeps = {
      ...defaultRecordingSessionCleanupDeps,
      timer,
      // The stage before the device-gesture-recording stop never settles (a wedged capture backend).
      stopSegmentedRecordings: () => new Promise<void>(() => {}),
    };
    registerRecordingSessionCleanup(manager, deps);

    manager.release(OLD_HOLDER, device.deviceId);
    expect(manager.pendingCleanups).toHaveLength(1);
    const freed = Promise.all(manager.pendingCleanups);
    await timer.advanceTimersByTimeAsync(deps.finalizeCapMs(device.deviceId));
    // The pending cleanup settled: the device is free for the next holder from here on.
    await freed;
    return started.recordingId;
  };

  test("the released session's recorder is stopped once the cap frees the device", async () => {
    await releaseWithWedgedVideoStage();

    expect(recorderStops).toBe(1);
    expect(isDeviceGestureRecordingOwnedBy(OLD_HOLDER, device.deviceId)).toBe(false);
    expect(getDeviceGestureRecordingStatus()).toBeNull();
  });

  test("the next holder's start gets its own recording, not the released session's", async () => {
    const oldRecordingId = await releaseWithWedgedVideoStage();

    const next = await startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator("next"),
      recorder,
      NEW_HOLDER,
    );

    expect(next.recordingId).not.toBe(oldRecordingId);
    expect(isDeviceGestureRecordingOwnedBy(NEW_HOLDER, device.deviceId)).toBe(true);
  });
});
