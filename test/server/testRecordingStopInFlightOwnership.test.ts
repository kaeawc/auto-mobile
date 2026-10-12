import { describe, expect, test } from "bun:test";
import type { BootedDevice, PlanStep } from "../../src/models";
import {
  isTestRecordingOwnedBy,
  joinInFlightTestRecordingStop,
  ownedTestRecordingId,
  resetStoppedTestRecordings,
  startTestRecording,
  stopTestRecording,
} from "../../src/server/testRecordingManager";
import {
  defaultRecordingSessionCleanupDeps,
  registerRecordingSessionCleanup,
  takeRecordingIdsFinalizedByRelease,
  type RecordingSessionCleanupDeps,
} from "../../src/server/recordingSessionCleanup";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const step: PlanStep = { tool: "tapOn", params: { text: "OK" } };

describe("test recording ownership while its stop is in flight", () => {
  test("a recorder still stopping keeps its owner, so a release does not skip the pending cleanup", async () => {
    const timer = new FakeTimer();
    let finishStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const recorder = {
      stepCount: 0,
      start: async () => undefined,
      stop: async () => {
        await stopGate;
        return { steps: [step], stepCount: 1 };
      },
    };
    await startTestRecording(
      device,
      timer,
      new CountingIdGenerator("recording"),
      () => recorder,
      "session-a",
    );
    expect(isTestRecordingOwnedBy("session-a", device.deviceId)).toBe(true);

    // session-a explicitly stops; the recorder is still tearing down its capture processes.
    const stopping = stopTestRecording(undefined, undefined, timer);
    await Promise.resolve();

    // session-a is released now. The release cleanup gates on this predicate
    // (hasRecordingsToStop); a false answer returns the device to the pool with the
    // recorder's getevent/a11y capture still running and no device_cleanup_in_progress hold.
    expect(isTestRecordingOwnedBy("session-a", device.deviceId)).toBe(true);

    finishStop();
    await stopping;
  });
});

type CleanupManager = Parameters<typeof registerRecordingSessionCleanup>[0];
type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];

describe("releasing a session whose test recording stop is in flight (#11533)", () => {
  test("registers the pending device cleanup, names the id, and awaits the one in-flight stop", async () => {
    const timer = new FakeTimer();
    let finishStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    let recorderStops = 0;
    const recorder = {
      stepCount: 0,
      start: async () => undefined,
      stop: async () => {
        recorderStops += 1;
        await stopGate;
        return { steps: [step], stepCount: 1 };
      },
    };
    const { recordingId } = await startTestRecording(
      device,
      timer,
      new CountingIdGenerator("recording"),
      () => recorder,
      "session-a",
    );
    const stopping = stopTestRecording(undefined, undefined, timer);
    await Promise.resolve();
    expect(ownedTestRecordingId("session-a", device.deviceId)).toBe(recordingId);
    expect(ownedTestRecordingId("session-b", device.deviceId)).toBeUndefined();

    const releaseCallbacks: ReleaseCallback[] = [];
    const pending: Array<{ deviceId: string; cleanup: Promise<unknown>; capMs?: number }> = [];
    const manager: CleanupManager = {
      onSessionRelease: (callback) => void releaseCallbacks.push(callback),
      onSessionDeviceUnbound: () => undefined,
      registerPendingDeviceCleanup: (deviceId, cleanup, capMs) =>
        void pending.push({ deviceId, cleanup, capMs }),
    };
    const deps: RecordingSessionCleanupDeps = {
      ...defaultRecordingSessionCleanupDeps,
      hasRecordingsToStop: (sessionId, deviceId) => isTestRecordingOwnedBy(sessionId, deviceId),
      stopSegmentedRecordings: async () => undefined,
      listActiveVideoRecordings: async () => [],
      timer,
      finalizeCapMs: () => 120_000,
    };
    registerRecordingSessionCleanup(manager, deps);

    releaseCallbacks[0]("session-a", device.deviceId, "idle-timeout", {} as never, undefined);

    expect(pending).toHaveLength(1);
    expect(pending[0].deviceId).toBe(device.deviceId);
    expect(pending[0].capMs).toBe(125_000);
    expect(takeRecordingIdsFinalizedByRelease("session-a")).toEqual([recordingId]);
    let settled = false;
    void pending[0].cleanup.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    finishStop();
    await stopping;
    await pending[0].cleanup;
    expect(settled).toBe(true);
    expect(recorderStops).toBe(1);
    expect(isTestRecordingOwnedBy("session-a", device.deviceId)).toBe(false);
    resetStoppedTestRecordings();
  });
});

describe("joining the owner's in-flight recording stop", () => {
  test("base and sibling owners join; strangers and unknown ids return before teardown", async () => {
    const timer = new FakeTimer();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { recordingId } = await startTestRecording(
      device,
      timer,
      new CountingIdGenerator("derived"),
      () => ({
        stepCount: 1,
        start: async () => undefined,
        stop: async () => {
          await gate;
          return { steps: [step], stepCount: 1 };
        },
      }),
      "base:pixel",
    );
    const stopped = stopTestRecording(recordingId, undefined, timer);
    const base = (id: string) => id.split(":")[0];
    const fromBase = joinInFlightTestRecordingStop(recordingId, "base", base);
    const fromSibling = joinInFlightTestRecordingStop(recordingId, "base:other", base);
    expect(await joinInFlightTestRecordingStop(recordingId, "stranger", base)).toBeUndefined();
    expect(await joinInFlightTestRecordingStop(recordingId, undefined, base)).toBeUndefined();
    expect(await joinInFlightTestRecordingStop("unknown", "base", base)).toBeUndefined();
    finish();
    const result = await stopped;
    expect(await fromBase).toEqual(result);
    expect(await fromSibling).toEqual(result);
    resetStoppedTestRecordings();
  });

  test("a joined wedged stop shares the existing fake-timer deadline", async () => {
    const timer = new FakeTimer();
    const { recordingId } = await startTestRecording(
      device,
      timer,
      new CountingIdGenerator("deadline"),
      () => ({
        stepCount: 0,
        start: async () => undefined,
        stop: () => new Promise<{ steps: PlanStep[]; stepCount: number }>(() => {}),
      }),
      "owner",
    );
    const stopped = stopTestRecording(recordingId);
    const joined = joinInFlightTestRecordingStop(recordingId, "owner");
    const outcomes = Promise.allSettled([stopped, joined]);
    await timer.advanceTimersByTimeAsync(10_000);
    for (const result of await outcomes) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason.message).toContain("timed out");
      }
    }
    expect(ownedTestRecordingId("owner", device.deviceId)).toBeUndefined();
  });
});
