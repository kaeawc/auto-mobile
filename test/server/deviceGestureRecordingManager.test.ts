import { afterEach, describe, expect, test } from "bun:test";
import { ActionableError, type BootedDevice, type PlanStep } from "../../src/models";
import {
  adoptOwnerlessDeviceGestureRecording,
  getStoppedDeviceGestureRecording,
  getDeviceGestureRecordingStatus,
  isDeviceGestureRecordingOwnedBy,
  NoUserInputCapturedError,
  DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE,
  resetStoppedDeviceGestureRecordings,
  startDeviceGestureRecording,
  stopDeviceGestureRecording,
} from "../../src/daemon/deviceGestureRecordingManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { DualTrackRecorder } from "../../src/features/record/android/DualTrackRecorder";
import type {
  A11ySource,
  GestureEmitter,
  GestureEvent,
  ReceivedInteraction,
} from "../../src/features/record/android/types";
import { DisplayGeometryTracker } from "../../src/features/record/android/DisplayGeometryTracker";
import { ScreenGeometryTimeline } from "../../src/features/record/android/ScreenGeometryTimeline";
import { FakeTimer } from "../fakes/FakeTimer";

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (error: Error) => void;
  promise = new Promise<T>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
}

class FakeRecorder {
  startCount = 0;
  stopCount = 0;
  startGate = new Deferred<void>();
  stopGate: Deferred<{ steps: PlanStep[]; stepCount: number }> | null = null;
  stopError: Error | null = null;
  steps: PlanStep[] = [];
  /** What the recorder can still hand over after a failed stop. */
  capturedSteps: PlanStep[] | undefined;
  capturedExportWarnings: string[] | undefined;
  lastStopOptions?: { hostOnly?: boolean };

  get stepCount(): number {
    return this.steps.length;
  }

  async start(): Promise<void> {
    this.startCount++;
    await this.startGate.promise;
  }

  async stop(options?: { hostOnly?: boolean }): Promise<{ steps: PlanStep[]; stepCount: number }> {
    this.stopCount++;
    this.lastStopOptions = options;
    if (this.stopError) {
      throw this.stopError;
    }
    if (this.stopGate) {
      return this.stopGate.promise;
    }
    return { steps: this.steps, stepCount: this.steps.length };
  }
}

const capturedStep: PlanStep = { tool: "tapOn", params: { text: "OK" } };

const start = async (
  timer: FakeTimer,
  recorder: FakeRecorder,
  ids = new CountingIdGenerator("recording"),
  factory: (device: BootedDevice) => FakeRecorder = () => recorder,
) => {
  const pending = startDeviceGestureRecording(device, timer, ids, { recorderFactory: factory });
  await Promise.resolve();
  recorder.startGate.resolve();
  return { result: await pending, ids };
};

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const otherDevice: BootedDevice = { ...device, deviceId: "emulator-5556" };

describe("deviceGestureRecordingManager user-input capture contract (#11919)", () => {
  afterEach(async () => {
    if (getDeviceGestureRecordingStatus()) {
      await stopDeviceGestureRecording(undefined, "cleanup").catch(() => undefined);
    }
    resetStoppedDeviceGestureRecordings();
  });

  test.each([0, 1])("status documents user-input scope with %s steps", async (count) => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    recorder.steps = count ? [capturedStep] : [];
    await start(timer, recorder);
    const status = getDeviceGestureRecordingStatus(timer);
    expect(status?.eventCount).toBe(count);
    expect(status?.captureScope).toBe("user-input");
    if (count === 0) {
      expect(status?.notice).toBe(DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE);
      expect(status?.notice).toContain("recordToolCalls");
    } else {
      expect(status).not.toHaveProperty("notice");
    }
  });

  test("zero-step stop explains why injected input is not recorded", async () => {
    const timer = new FakeTimer();
    await start(timer, new FakeRecorder());
    const result = stopDeviceGestureRecording(undefined, "empty", timer);
    await expect(result).rejects.toBeInstanceOf(NoUserInputCapturedError);
    await expect(result).rejects.toMatchObject({ reason: "no_user_input_captured" });
    await expect(result).rejects.toThrow(/^No recorded interactions were captured\./);
    await expect(result).rejects.toThrow("recordToolCalls");
  });

  test("passes host-only stop options through to the recorder", async () => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    recorder.steps = [capturedStep];
    await start(timer, recorder);

    await stopDeviceGestureRecording(undefined, "host only", timer, { hostOnly: true });

    expect(recorder.lastStopOptions).toEqual({ hostOnly: true });
  });
});

describe("deviceGestureRecordingManager ownership", () => {
  for (const phase of ["starting", "active"] as const) {
    for (const [owner, caller, admitted] of [
      ["S", "S:label", true],
      ["S:label", "S", true],
      ["S:first", "S:second", true],
      ["S", "other:label", false],
      [undefined, undefined, true],
      [undefined, "S", false],
      ["S", undefined, false],
    ] as const) {
      test(`${phase} recording owned by ${owner} ${admitted ? "joins" : "refuses"} caller ${caller}`, async () => {
        const timer = new FakeTimer();
        const recorder = new FakeRecorder();
        recorder.steps = [capturedStep];
        const ids = new CountingIdGenerator("equivalent");
        const baseSessionUuid = (uuid: string) => uuid.split(":")[0];
        const pending = startDeviceGestureRecording(device, timer, ids, {
          recorderFactory: () => recorder,
          ownerSessionUuid: owner,
          baseSessionUuid,
        });
        await Promise.resolve();
        if (phase === "active") {
          recorder.startGate.resolve();
          await pending;
        }
        try {
          const joined = startDeviceGestureRecording(device, timer, ids, {
            recorderFactory: () => {
              throw new Error("joining must reuse the recorder");
            },
            ownerSessionUuid: caller,
            baseSessionUuid,
          });
          if (!admitted) {
            await expect(joined).rejects.toThrow("another session");
          }
          recorder.startGate.resolve();
          const first = await pending;
          if (admitted) {
            expect(await joined).toEqual(first);
          }
          expect(recorder.startCount).toBe(1);
          expect(isDeviceGestureRecordingOwnedBy(owner, device.deviceId)).toBe(true);
        } finally {
          recorder.startGate.resolve();
          await pending;
          await stopDeviceGestureRecording(undefined, undefined, timer);
        }
      });
    }
  }

  test.each(["starting", "active", "stopping"])(
    "a direct ownerless %s recording is adopted once and its finalized plan belongs to the holder",
    async (phase) => {
      const timer = new FakeTimer();
      const recorder = new FakeRecorder();
      recorder.steps = [capturedStep];
      const pending = startDeviceGestureRecording(device, timer, new CountingIdGenerator("adopt"), {
        recorderFactory: () => recorder,
      });
      await Promise.resolve();
      if (phase !== "starting") {
        recorder.startGate.resolve();
        await pending;
      }
      let stop: ReturnType<typeof stopDeviceGestureRecording> | undefined;
      if (phase === "stopping") {
        recorder.stopGate = new Deferred();
        stop = stopDeviceGestureRecording(undefined, undefined, timer);
      }
      try {
        expect(isDeviceGestureRecordingOwnedBy(undefined, device.deviceId)).toBe(true);
        expect(adoptOwnerlessDeviceGestureRecording(otherDevice.deviceId, "holder")).toBe(false);
        expect(adoptOwnerlessDeviceGestureRecording(device.deviceId, "holder")).toBe(true);
        expect(adoptOwnerlessDeviceGestureRecording(device.deviceId, "loser")).toBe(false);
        expect(isDeviceGestureRecordingOwnedBy(undefined, device.deviceId)).toBe(false);
        expect(isDeviceGestureRecordingOwnedBy("holder", device.deviceId)).toBe(true);
        expect(recorder.stopCount).toBe(phase === "stopping" ? 1 : 0);
        recorder.startGate.resolve();
        const started = await pending;
        recorder.stopGate?.resolve({ steps: recorder.steps, stepCount: 1 });
        const stopped = await (stop ?? stopDeviceGestureRecording(undefined, undefined, timer));
        expect(stopped.recordingId).toBe(started.recordingId);
        expect(getStoppedDeviceGestureRecording(started.recordingId, "holder")?.stepCount).toBe(1);
        expect(getStoppedDeviceGestureRecording(started.recordingId, "loser")).toBeUndefined();
        expect(adoptOwnerlessDeviceGestureRecording(device.deviceId, "next")).toBe(false);
      } finally {
        recorder.startGate.resolve();
        recorder.stopGate?.resolve({ steps: recorder.steps, stepCount: 1 });
        if (
          isDeviceGestureRecordingOwnedBy("holder", device.deviceId) ||
          isDeviceGestureRecordingOwnedBy(undefined, device.deviceId)
        ) {
          await stopDeviceGestureRecording(undefined, undefined, timer);
        }
      }
    },
  );

  test("a recording is owned by the session that started it, on its device only", async () => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    const pending = startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator("recording"),
      { recorderFactory: () => recorder, ownerSessionUuid: "session-a" },
    );
    await Promise.resolve();
    recorder.startGate.resolve();
    await pending;

    expect(isDeviceGestureRecordingOwnedBy("session-a", device.deviceId)).toBe(true);
    expect(isDeviceGestureRecordingOwnedBy("session-b", device.deviceId)).toBe(false);
    expect(isDeviceGestureRecordingOwnedBy("session-a", otherDevice.deviceId)).toBe(false);

    recorder.steps.push(capturedStep);
    await stopDeviceGestureRecording(undefined, "owned", timer);
    expect(isDeviceGestureRecordingOwnedBy("session-a", device.deviceId)).toBe(false);
  });
});

describe("deviceGestureRecordingManager retained plan (#10958)", () => {
  test("an owned recording's plan stays fetchable by its owner after the stop, and only by it", async () => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    const pending = startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator("recording"),
      { recorderFactory: () => recorder, ownerSessionUuid: "session-a" },
    );
    await Promise.resolve();
    recorder.startGate.resolve();
    const { recordingId } = await pending;
    recorder.steps.push(capturedStep);

    const stopped = await stopDeviceGestureRecording(undefined, "owned", timer);

    expect(getStoppedDeviceGestureRecording(recordingId, "session-a")).toEqual(stopped);
    expect(getStoppedDeviceGestureRecording(recordingId, "session-b")).toBeUndefined();
    expect(getStoppedDeviceGestureRecording(recordingId, undefined)).toBeUndefined();
  });

  test("a derived owner's retained plan is fetchable by its base and sibling sessions, never another base (#11533)", async () => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    const pending = startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator("recording"),
      { recorderFactory: () => recorder, ownerSessionUuid: "plan-base:pixel" },
    );
    await Promise.resolve();
    recorder.startGate.resolve();
    const { recordingId } = await pending;
    recorder.steps.push(capturedStep);
    const stopped = await stopDeviceGestureRecording(undefined, "owned", timer);

    const base = (uuid: string) => uuid.split(":")[0];
    expect(getStoppedDeviceGestureRecording(recordingId, "plan-base", base)).toEqual(stopped);
    expect(getStoppedDeviceGestureRecording(recordingId, "plan-base:tablet", base)).toEqual(
      stopped,
    );
    expect(getStoppedDeviceGestureRecording(recordingId, "plan-base:pixel", base)).toEqual(stopped);
    expect(getStoppedDeviceGestureRecording(recordingId, "other-base", base)).toBeUndefined();
    expect(getStoppedDeviceGestureRecording(recordingId, "other-base:pixel", base)).toBeUndefined();
    expect(getStoppedDeviceGestureRecording(recordingId, "plan-base2", base)).toBeUndefined();
    expect(getStoppedDeviceGestureRecording(recordingId, undefined, base)).toBeUndefined();
    // Without a resolver the base session still matches by the derived-id prefix.
    expect(getStoppedDeviceGestureRecording(recordingId, "plan-base")).toEqual(stopped);
  });
});

describe("deviceGestureRecordingManager startup reservation", () => {
  for (const [owner, stranger] of [
    [undefined, "stranger"],
    ["owner-a", undefined],
    ["owner-a", "owner-b"],
    ["base:pixel", "base2"],
  ]) {
    test(`active and starting recordings refuse another owner (${owner ?? "ownerless"} / ${stranger ?? "ownerless"})`, async () => {
      const timer = new FakeTimer();
      const ids = new CountingIdGenerator("owner-check");
      const recorder = new FakeRecorder();
      recorder.steps = [capturedStep];
      let factories = 0;
      const factory = () => {
        factories += 1;
        return recorder;
      };
      const first = startDeviceGestureRecording(device, timer, ids, {
        recorderFactory: factory,
        ownerSessionUuid: owner,
      });
      const checkRefusal = async () => {
        try {
          await startDeviceGestureRecording(device, timer, ids, {
            recorderFactory: factory,
            ownerSessionUuid: stranger,
          });
          throw new Error("expected an ownership refusal");
        } catch (error) {
          expect(error).toBeInstanceOf(ActionableError);
          expect((error as Error).message).toContain("owned by another session");
          if (owner) {
            expect((error as Error).message).not.toContain(owner);
          }
        }
        expect(factories).toBe(1);
        expect(recorder.stopCount).toBe(0);
      };
      await checkRefusal();
      const sameOwner = startDeviceGestureRecording(device, timer, ids, {
        recorderFactory: factory,
        ownerSessionUuid: owner,
      });
      recorder.startGate.resolve();
      expect(await sameOwner).toEqual(await first);
      await checkRefusal();
      expect(
        await startDeviceGestureRecording(device, timer, ids, {
          recorderFactory: factory,
          ownerSessionUuid: owner,
        }),
      ).toEqual(await first);
      await expect(
        startDeviceGestureRecording(otherDevice, timer, ids, {
          recorderFactory: factory,
          ownerSessionUuid: stranger,
        }),
      ).rejects.toThrow("Recording already active on device");
      await stopDeviceGestureRecording(undefined, undefined, timer);
    });
  }

  test("same-device callers join one start; a different device is refused", async () => {
    const timer = new FakeTimer();
    const ids = new CountingIdGenerator("recording");
    const recorder = new FakeRecorder();
    let constructed = 0;
    const factory = () => {
      constructed++;
      return recorder;
    };

    const first = startDeviceGestureRecording(device, timer, ids, { recorderFactory: factory });
    const second = startDeviceGestureRecording(device, timer, ids, { recorderFactory: factory });
    await expect(
      startDeviceGestureRecording(otherDevice, timer, ids, { recorderFactory: factory }),
    ).rejects.toThrow("Recording already active on device emulator-5554");
    await Promise.resolve();
    expect(constructed).toBe(1);
    expect(recorder.startCount).toBe(1);
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();

    recorder.startGate.resolve();
    expect(await first).toEqual(await second);
    expect(getDeviceGestureRecordingStatus(timer)?.recordingId).toBe("recording-1");
    await expect(stopDeviceGestureRecording(undefined, undefined, timer)).rejects.toThrow(
      "No recorded interactions",
    );
    expect(recorder.stopCount).toBe(1);
  });

  test("failed startup tears down its recorder and releases the reservation", async () => {
    const timer = new FakeTimer();
    const ids = new CountingIdGenerator("recording");
    const failed = new FakeRecorder();
    const first = startDeviceGestureRecording(device, timer, ids, {
      recorderFactory: () => failed,
    });
    const joined = startDeviceGestureRecording(device, timer, ids, {
      recorderFactory: () => {
        throw new Error("second recorder must not be constructed");
      },
    });
    const failures = Promise.allSettled([first, joined]);
    await Promise.resolve();
    failed.startGate.reject(new Error("adb startup failed"));
    const outcomes = await failures;
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toHaveProperty(
          "message",
          "Failed to start device gesture recording: adb startup failed",
        );
      }
    }
    expect(failed.stopCount).toBe(1);
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();

    const next = new FakeRecorder();
    const retry = startDeviceGestureRecording(otherDevice, timer, ids, {
      recorderFactory: () => next,
    });
    next.startGate.resolve();
    expect((await retry).deviceId).toBe(otherDevice.deviceId);
    await expect(stopDeviceGestureRecording(undefined, undefined, timer)).rejects.toThrow(
      "No recorded interactions",
    );
  });
});

describe("deviceGestureRecordingManager stopping reservation", () => {
  test("successful stop releases the active recording and returns its result", async () => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    recorder.steps = [capturedStep];
    const { result: started } = await start(timer, recorder);

    const result = await stopDeviceGestureRecording(started.recordingId, undefined, timer);

    expect(result.recordingId).toBe(started.recordingId);
    expect(result.stepCount).toBe(1);
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
    expect(recorder.stopCount).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("rejected stop releases the session and a new start constructs a new recorder", async () => {
    const timer = new FakeTimer();
    const ids = new CountingIdGenerator("recording");
    const failed = new FakeRecorder();
    failed.stopError = new Error("device disconnected");
    const { result: started } = await start(timer, failed, ids);

    const stopError = await stopDeviceGestureRecording(started.recordingId, undefined, timer).catch(
      (error: unknown) => error,
    );
    expect(stopError).toBeInstanceOf(ActionableError);
    expect(stopError).toHaveProperty(
      "message",
      "Failed to stop device gesture recording: device disconnected",
    );
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();

    const replacement = new FakeRecorder();
    let factoryCalls = 0;
    const next = startDeviceGestureRecording(device, timer, ids, {
      recorderFactory: () => {
        factoryCalls++;
        return replacement;
      },
    });
    await Promise.resolve();
    replacement.startGate.resolve();
    const nextStarted = await next;
    expect(nextStarted.recordingId).not.toBe(started.recordingId);
    expect(factoryCalls).toBe(1);
    await expect(stopDeviceGestureRecording(undefined, undefined, timer)).rejects.toThrow(
      "No recorded interactions",
    );
  });

  test("timed out stop releases the session and allows a fresh start", async () => {
    const timer = new FakeTimer();
    const ids = new CountingIdGenerator("recording");
    const hung = new FakeRecorder();
    hung.stopGate = new Deferred<{ steps: PlanStep[]; stepCount: number }>();
    const { result: started } = await start(timer, hung, ids);

    const stopping = stopDeviceGestureRecording(started.recordingId, undefined, timer);
    await Promise.resolve();
    timer.advanceTime(10_000);
    const timeoutError = await stopping.catch((error: unknown) => error);
    expect(timeoutError).toBeInstanceOf(ActionableError);
    expect(timeoutError).toHaveProperty(
      "message",
      "Failed to stop device gesture recording: Device gesture recording stop timed out after 10000 ms",
    );
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();

    const replacement = new FakeRecorder();
    const next = startDeviceGestureRecording(device, timer, ids, {
      recorderFactory: () => replacement,
    });
    await Promise.resolve();
    replacement.startGate.resolve();
    expect((await next).recordingId).not.toBe(started.recordingId);
    await expect(stopDeviceGestureRecording(undefined, undefined, timer)).rejects.toThrow(
      "No recorded interactions",
    );
  });

  test("a stop that times out still returns the steps already captured, with a warning", async () => {
    const timer = new FakeTimer();
    const hung = new FakeRecorder();
    hung.stopGate = new Deferred<{ steps: PlanStep[]; stepCount: number }>();
    hung.capturedSteps = [capturedStep];
    const { result: started } = await start(timer, hung);

    const stopping = stopDeviceGestureRecording(started.recordingId, undefined, timer);
    await Promise.resolve();
    timer.advanceTime(10_000);
    const result = await stopping;

    expect(result.stepCount).toBe(1);
    expect(result.planContent).toContain("OK");
    expect(result.error).toContain("Stopping the recorder did not finish");
    expect(result.error).toContain("timed out after 10000 ms");
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
  });

  test("a salvaged stop still reports input that was left out of the plan", async () => {
    const timer = new FakeTimer();
    const hung = new FakeRecorder();
    hung.stopGate = new Deferred<{ steps: PlanStep[]; stepCount: number }>();
    hung.capturedSteps = [capturedStep];
    hung.capturedExportWarnings = ["an eraser gesture was not exported"];
    const { result: started } = await start(timer, hung);

    const stopping = stopDeviceGestureRecording(started.recordingId, undefined, timer);
    await Promise.resolve();
    timer.advanceTime(10_000);
    const result = await stopping;

    expect(result.error).toContain("Stopping the recorder did not finish");
    expect(result.error).toContain("an eraser gesture was not exported");
  });

  test("a stop that fails with nothing captured still rejects", async () => {
    const timer = new FakeTimer();
    const failed = new FakeRecorder();
    failed.stopError = new Error("device disconnected");
    failed.capturedSteps = [];
    const { result: started } = await start(timer, failed);

    await expect(stopDeviceGestureRecording(started.recordingId, undefined, timer)).rejects.toThrow(
      "Failed to stop device gesture recording: device disconnected",
    );
  });

  test("concurrent stops share the successful stop result", async () => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    recorder.steps = [capturedStep];
    recorder.stopGate = new Deferred<{ steps: PlanStep[]; stepCount: number }>();
    const { result: started } = await start(timer, recorder);

    const first = stopDeviceGestureRecording(started.recordingId, undefined, timer);
    const second = stopDeviceGestureRecording(started.recordingId, undefined, timer);
    await Promise.resolve();
    expect(recorder.stopCount).toBe(1);
    recorder.stopGate.resolve({ steps: [capturedStep], stepCount: 1 });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
  });

  test("concurrent stops share the same failure", async () => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    recorder.stopGate = new Deferred<{ steps: PlanStep[]; stepCount: number }>();
    const { result: started } = await start(timer, recorder);

    const first = stopDeviceGestureRecording(started.recordingId, undefined, timer);
    const second = stopDeviceGestureRecording(started.recordingId, undefined, timer);
    await Promise.resolve();
    expect(recorder.stopCount).toBe(1);
    recorder.stopGate.reject(new Error("stop failed"));
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes[0]?.status).toBe("rejected");
    expect(outcomes[1]?.status).toBe("rejected");
    if (outcomes[0]?.status === "rejected" && outcomes[1]?.status === "rejected") {
      expect(outcomes[0].reason).toBe(outcomes[1].reason);
      expect(outcomes[0].reason.message).toContain("stop failed");
    }
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
  });

  test("start during an in-flight stop waits, then creates a fresh recording", async () => {
    const timer = new FakeTimer();
    const ids = new CountingIdGenerator("recording");
    const firstRecorder = new FakeRecorder();
    firstRecorder.steps = [capturedStep];
    firstRecorder.stopGate = new Deferred<{ steps: PlanStep[]; stepCount: number }>();
    const { result: started } = await start(timer, firstRecorder, ids);

    const stopping = stopDeviceGestureRecording(started.recordingId, undefined, timer);
    await Promise.resolve();
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
    const nextRecorder = new FakeRecorder();
    let factoryCalls = 0;
    const starting = startDeviceGestureRecording(device, timer, ids, {
      recorderFactory: () => {
        factoryCalls++;
        return nextRecorder;
      },
    });
    await Promise.resolve();
    expect(factoryCalls).toBe(0);

    firstRecorder.stopGate.resolve({ steps: [capturedStep], stepCount: 1 });
    await stopping;
    await Promise.resolve();
    expect(factoryCalls).toBe(1);
    nextRecorder.startGate.resolve();
    const nextStarted = await starting;
    expect(nextStarted.recordingId).not.toBe(started.recordingId);
    await expect(stopDeviceGestureRecording(undefined, undefined, timer)).rejects.toThrow(
      "No recorded interactions",
    );
  });
});

class RecordingGestures implements GestureEmitter {
  onGesture?: (event: GestureEvent) => void;
  onError?: (error: Error) => void;
  start(onGesture: (event: GestureEvent) => void, onError?: (error: Error) => void): void {
    this.onGesture = onGesture;
    this.onError = onError;
  }
  stop(): void {
    this.onError?.(new Error("getevent shutdown"));
  }
}

class RecordingA11y implements A11ySource {
  listener?: (event: ReceivedInteraction) => void;
  async ensureConnected(): Promise<boolean> {
    return true;
  }
  async getSupportedCommands(): Promise<string[] | null> {
    return [];
  }
  onInteraction(listener: (event: ReceivedInteraction) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
}

async function startDualTrack() {
  const timer = new FakeTimer();
  timer.advanceTime(10_000);
  const gestures = new RecordingGestures();
  const a11y = new RecordingA11y();
  await startDeviceGestureRecording(device, timer, new CountingIdGenerator("touch-health"), {
    recorderFactory: () => new DualTrackRecorder(device, gestures, a11y, { timer }),
  });
  return { timer, gestures, a11y };
}

describe("deviceGestureRecordingManager touch-track health", () => {
  test("spawn failure with zero steps rejects with actionable getevent cause", async () => {
    const { timer, gestures } = await startDualTrack();
    gestures.onError?.(new Error("spawn adb ENOENT"));
    const outcome = await stopDeviceGestureRecording(undefined, "failed-touch", timer).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(ActionableError);
    expect(outcome).not.toBeInstanceOf(NoUserInputCapturedError);
    expect(outcome).toHaveProperty(
      "message",
      "Failed to stop device gesture recording: Touch track (getevent) stopped 0 ms after recording start: spawn adb ENOENT. Later taps may be missing.",
    );
    expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
  });

  test.each(["code 1", "signal SIGTERM"])(
    "partial touch plan warns at the first failure (%s)",
    async (cause) => {
      const { timer, gestures } = await startDualTrack();
      gestures.onGesture?.({ type: "tap", arrivedAt: timer.now(), screenX: 10, screenY: 20 });
      timer.advanceTime(1250);
      gestures.onError?.(new Error(`getevent exited with ${cause}`));
      timer.advanceTime(500);
      gestures.onError?.(new Error("later error"));
      const result = await stopDeviceGestureRecording(undefined, "partial-touch", timer);
      expect(result.stepCount).toBe(1);
      expect(result.planContent).toContain("tapAt");
      expect(result.error).toBe(
        `Warning: Touch track (getevent) stopped 1250 ms after recording start: getevent exited with ${cause}. Later taps may be missing.`,
      );
      expect(result.durationMs).toBe(1750);
    },
  );

  test("inputText-only partial plan survives with a warning after touch failure", async () => {
    const { timer, gestures, a11y } = await startDualTrack();
    gestures.onError?.(new Error("getevent permission denied"));
    a11y.listener?.({ type: "tap", timestamp: 0 });
    a11y.listener?.({ type: "inputText", text: "hello", timestamp: 0 });
    a11y.listener?.({ type: "tap", timestamp: 0 });
    const result = await stopDeviceGestureRecording(undefined, "text-only", timer);
    expect(result.stepCount).toBe(1);
    expect(result.planContent).toContain("sendKeys");
    expect(result.planContent).toContain("hello");
    expect(result.error).toContain("getevent permission denied");
    expect(result.error).toContain("Later taps may be missing");
  });

  test("healthy stop has no warning even when the emitter reports its own shutdown", async () => {
    const { timer, gestures } = await startDualTrack();
    gestures.onGesture?.({ type: "tap", arrivedAt: timer.now(), screenX: 10, screenY: 20 });
    const result = await stopDeviceGestureRecording(undefined, "healthy-touch", timer);
    expect(result.stepCount).toBe(1);
    expect(Object.keys(result).sort()).toEqual(
      [
        "recordingId",
        "startedAt",
        "stoppedAt",
        "durationMs",
        "planName",
        "planContent",
        "stepCount",
        "deviceId",
        "platform",
      ].sort(),
    );
  });
});

function geometryTracker(timer: FakeTimer, deviceRotation: number): DisplayGeometryTracker {
  const timeline = new ScreenGeometryTimeline(
    { xMin: 0, xMax: 32767, yMin: 0, yMax: 32767 },
    { rotation: 0, display: { width: 1080, height: 2400 } },
    timer.now(),
  );
  return new DisplayGeometryTracker(
    timeline,
    {
      readRotation: async () => deviceRotation,
      readPhysicalSize: async () => ({ width: 1080, height: 2400 }),
    },
    timer,
  );
}

describe("deviceGestureRecordingManager display geometry (#10174)", () => {
  test("a rotation that was never pushed warns on the stop result", async () => {
    const timer = new FakeTimer();
    timer.advanceTime(10_000);
    const gestures = new RecordingGestures();
    const tracker = geometryTracker(timer, 1);
    await startDeviceGestureRecording(device, timer, new CountingIdGenerator("geometry"), {
      recorderFactory: () =>
        new DualTrackRecorder(device, gestures, new RecordingA11y(), { timer, geometry: tracker }),
    });
    gestures.onGesture?.({
      type: "tap",
      arrivedAt: timer.now(),
      screenX: 918,
      screenY: 1184,
      downAt: timer.now() - 100,
    });
    // The device reads rotation 1 although none was pushed; the stop-time check notices.
    const result = await stopDeviceGestureRecording(undefined, "rotated", timer);

    expect(result.stepCount).toBe(1);
    expect(result.error).toStartWith(
      "Warning: Display geometry changed or was unreadable during recording:",
    );
    expect(result.error).toContain("display rotation at stop (1) differs");
  });

  test("a labelled step survives plan validation and the result warns", async () => {
    const timer = new FakeTimer();
    timer.advanceTime(10_000);
    const gestures = new RecordingGestures();
    const tracker = geometryTracker(timer, 1);
    await startDeviceGestureRecording(device, timer, new CountingIdGenerator("geometry-label"), {
      recorderFactory: () =>
        new DualTrackRecorder(device, gestures, new RecordingA11y(), { timer, geometry: tracker }),
    });
    tracker.handleTransition({ change: "changed", displayId: 0, rotation: 1 });
    timer.advanceTime(100);
    gestures.onGesture?.({
      type: "tap",
      arrivedAt: timer.now(),
      screenX: 1184,
      screenY: 162,
      downAt: timer.now() - 50,
    });
    const result = await stopDeviceGestureRecording(undefined, "labelled", timer);

    expect(result.stepCount).toBe(1);
    expect(result.planContent).toContain("label: 'Warning: display rotation/size changed within");
    expect(result.error).toContain("Steps labelled");
  });

  test("a recording whose geometry never changed has no warning and no labels", async () => {
    const timer = new FakeTimer();
    timer.advanceTime(10_000);
    const gestures = new RecordingGestures();
    const tracker = geometryTracker(timer, 0);
    await startDeviceGestureRecording(device, timer, new CountingIdGenerator("geometry-clean"), {
      recorderFactory: () =>
        new DualTrackRecorder(device, gestures, new RecordingA11y(), { timer, geometry: tracker }),
    });
    timer.advanceTime(5_000);
    gestures.onGesture?.({
      type: "tap",
      arrivedAt: timer.now(),
      screenX: 918,
      screenY: 1184,
      downAt: timer.now() - 100,
    });
    const result = await stopDeviceGestureRecording(undefined, "steady", timer);

    expect(result.error).toBeUndefined();
    expect(result.planContent).not.toContain("label");
  });
});

describe("deviceGestureRecordingManager stylus export (#13084)", () => {
  async function recordPenGestures(planName: string, events: GestureEvent[]) {
    const timer = new FakeTimer();
    timer.advanceTime(10_000);
    const gestures = new RecordingGestures();
    await startDeviceGestureRecording(device, timer, new CountingIdGenerator(planName), {
      recorderFactory: () =>
        new DualTrackRecorder(device, gestures, new RecordingA11y(), { timer }),
    });
    for (const event of events) {
      gestures.onGesture?.({ ...event, arrivedAt: timer.now() });
    }
    return stopDeviceGestureRecording(undefined, planName, timer);
  }

  test("a stylus tap reaches the plan with its pointer and no warning", async () => {
    const result = await recordPenGestures("pen-tap", [
      { type: "tap", arrivedAt: 0, screenX: 40, screenY: 80, toolType: "stylus" },
    ]);

    expect(result.stepCount).toBe(1);
    expect(result.planContent).toContain("tool: tapAt");
    expect(result.planContent).toMatch(/pointer:\s+toolType: stylus/);
    expect(result.error).toBeUndefined();
  });

  test("a recording where every pen gesture was skipped says why instead of reporting nothing", async () => {
    const attempt = recordPenGestures("pen-eraser-only", [
      { type: "tap", arrivedAt: 0, screenX: 90, screenY: 99, toolType: "eraser" },
    ]);

    await expect(attempt).rejects.toBeInstanceOf(NoUserInputCapturedError);
    await expect(attempt).rejects.toThrow("eraser");
  });

  test("an eraser gesture is left out and the result says so", async () => {
    const result = await recordPenGestures("pen-eraser", [
      { type: "tap", arrivedAt: 0, screenX: 40, screenY: 80, toolType: "stylus" },
      { type: "tap", arrivedAt: 0, screenX: 90, screenY: 99, toolType: "eraser" },
    ]);

    expect(result.stepCount).toBe(1);
    expect(result.error).toStartWith("Warning:");
    expect(result.error).toContain("eraser");
  });
});
