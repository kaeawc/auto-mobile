import { describe, expect, test } from "bun:test";
import type { BootedDevice, PlanStep } from "../../src/models";
import {
  isDeviceGestureRecordingOwnedBy,
  joinInFlightDeviceGestureRecordingStop,
  ownedDeviceGestureRecordingId,
  resetStoppedDeviceGestureRecordings,
  startDeviceGestureRecording,
  stopDeviceGestureRecording,
} from "../../src/daemon/deviceGestureRecordingManager";
import {
  defaultRecordingSessionCleanupDeps,
  registerRecordingSessionCleanup,
  takeRecordingIdsFinalizedByRelease,
  type RecordingSessionCleanupDeps,
} from "../../src/daemon/recordingSessionCleanup";
import type {
  AbandonablePendingDeviceCleanup,
  SessionManager,
} from "../../src/daemon/sessionManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const step: PlanStep = { tool: "tapOn", params: { text: "OK" } };

describe("device gesture recording ownership while its stop is in flight", () => {
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
    await startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator("recording"),
      () => recorder,
      { ownerSessionUuid: "session-a" },
    );
    expect(isDeviceGestureRecordingOwnedBy("session-a", device.deviceId)).toBe(true);

    // session-a explicitly stops; the recorder is still tearing down its capture processes.
    const stopping = stopDeviceGestureRecording(undefined, undefined, timer);
    await Promise.resolve();

    // session-a is released now. The release cleanup gates on this predicate
    // (hasRecordingsToStop); a false answer returns the device to the pool with the
    // recorder's getevent/a11y capture still running and no device_cleanup_in_progress hold.
    expect(isDeviceGestureRecordingOwnedBy("session-a", device.deviceId)).toBe(true);

    finishStop();
    await stopping;
  });
});

type CleanupManager = Parameters<typeof registerRecordingSessionCleanup>[0];
type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];

describe("releasing a session whose device gesture recording stop is in flight (#11533)", () => {
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
    const { recordingId } = await startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator("recording"),
      () => recorder,
      { ownerSessionUuid: "session-a" },
    );
    const stopping = stopDeviceGestureRecording(undefined, undefined, timer);
    await Promise.resolve();
    expect(ownedDeviceGestureRecordingId("session-a", device.deviceId)).toBe(recordingId);
    expect(ownedDeviceGestureRecordingId("session-b", device.deviceId)).toBeUndefined();

    const releaseCallbacks: ReleaseCallback[] = [];
    const pending: Array<{
      deviceId: string;
      cleanup: Promise<unknown>;
      capMs?: number | AbandonablePendingDeviceCleanup;
    }> = [];
    const manager: CleanupManager = {
      onSessionRelease: (callback) => void releaseCallbacks.push(callback),
      onSessionDeviceUnbound: () => undefined,
      registerPendingDeviceCleanup: (deviceId, cleanup, capMs) =>
        void pending.push({ deviceId, cleanup, capMs }),
    };
    const deps: RecordingSessionCleanupDeps = {
      ...defaultRecordingSessionCleanupDeps,
      hasRecordingsToStop: (sessionId, deviceId) =>
        isDeviceGestureRecordingOwnedBy(sessionId, deviceId),
      stopSegmentedRecordings: async () => undefined,
      listActiveVideoRecordings: async () => [],
      timer,
      finalizeCapMs: () => 120_000,
    };
    registerRecordingSessionCleanup(manager, deps);

    releaseCallbacks[0]?.(
      "session-a",
      device.deviceId,
      "idle-timeout",
      {
        sessionId: "session-a",
        deviceId: device.deviceId,
        releaseReason: "idle-timeout",
        releasedAtMs: 0,
        terminal: false,
        heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
      },
      {},
    );

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
    expect(isDeviceGestureRecordingOwnedBy("session-a", device.deviceId)).toBe(false);
    resetStoppedDeviceGestureRecordings();
  });
});

describe("joining the owner's in-flight recording stop", () => {
  test("base and sibling owners join; strangers and unknown ids return before teardown", async () => {
    const timer = new FakeTimer();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { recordingId } = await startDeviceGestureRecording(
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
      { ownerSessionUuid: "base:pixel" },
    );
    const stopped = stopDeviceGestureRecording(recordingId, undefined, timer);
    const base = (id: string) => id.split(":")[0];
    const fromBase = joinInFlightDeviceGestureRecordingStop(recordingId, "base", base);
    const fromSibling = joinInFlightDeviceGestureRecordingStop(recordingId, "base:other", base);
    expect(
      await joinInFlightDeviceGestureRecordingStop(recordingId, "stranger", base),
    ).toBeUndefined();
    expect(
      await joinInFlightDeviceGestureRecordingStop(recordingId, undefined, base),
    ).toBeUndefined();
    expect(await joinInFlightDeviceGestureRecordingStop("unknown", "base", base)).toBeUndefined();
    finish();
    const result = await stopped;
    expect(await fromBase).toEqual(result);
    expect(await fromSibling).toEqual(result);
    resetStoppedDeviceGestureRecordings();
  });

  test("a joined wedged stop shares the existing fake-timer deadline", async () => {
    const timer = new FakeTimer();
    const { recordingId } = await startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator("deadline"),
      () => ({
        stepCount: 0,
        start: async () => undefined,
        stop: () => new Promise<{ steps: PlanStep[]; stepCount: number }>(() => {}),
      }),
      { ownerSessionUuid: "owner" },
    );
    const stopped = stopDeviceGestureRecording(recordingId);
    const joined = joinInFlightDeviceGestureRecordingStop(recordingId, "owner");
    const outcomes = Promise.allSettled([stopped, joined]);
    await timer.advanceTimersByTimeAsync(10_000);
    for (const result of await outcomes) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason.message).toContain("timed out");
      }
    }
    expect(ownedDeviceGestureRecordingId("owner", device.deviceId)).toBeUndefined();
  });
});
