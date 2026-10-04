import { describe, expect, test } from "bun:test";
import { ActionableError, type BootedDevice, type PlanStep } from "../../src/models";
import {
  getTestRecordingStatus,
  startTestRecording,
  stopTestRecording,
} from "../../src/server/testRecordingManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { DualTrackRecorder } from "../../src/features/record/android/DualTrackRecorder";
import type {
  A11ySource,
  GestureEmitter,
  GestureEvent,
  ReceivedInteraction,
} from "../../src/features/record/android/types";
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

  get stepCount(): number {
    return 0;
  }

  async start(): Promise<void> {
    this.startCount++;
    await this.startGate.promise;
  }

  async stop(): Promise<{ steps: PlanStep[]; stepCount: number }> {
    this.stopCount++;
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
  const pending = startTestRecording(device, timer, ids, factory);
  await Promise.resolve();
  recorder.startGate.resolve();
  return { result: await pending, ids };
};

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const otherDevice: BootedDevice = { ...device, deviceId: "emulator-5556" };

describe("testRecordingManager startup reservation", () => {
  test("same-device callers join one start; a different device is refused", async () => {
    const timer = new FakeTimer();
    const ids = new CountingIdGenerator("recording");
    const recorder = new FakeRecorder();
    let constructed = 0;
    const factory = () => {
      constructed++;
      return recorder;
    };

    const first = startTestRecording(device, timer, ids, factory);
    const second = startTestRecording(device, timer, ids, factory);
    await expect(startTestRecording(otherDevice, timer, ids, factory)).rejects.toThrow(
      "Recording already active on device emulator-5554",
    );
    await Promise.resolve();
    expect(constructed).toBe(1);
    expect(recorder.startCount).toBe(1);
    expect(getTestRecordingStatus(timer)).toBeNull();

    recorder.startGate.resolve();
    expect(await first).toEqual(await second);
    expect(getTestRecordingStatus(timer)?.recordingId).toBe("recording-1");
    await expect(stopTestRecording(undefined, undefined, timer)).rejects.toThrow(
      "No recorded interactions",
    );
    expect(recorder.stopCount).toBe(1);
  });

  test("failed startup tears down its recorder and releases the reservation", async () => {
    const timer = new FakeTimer();
    const ids = new CountingIdGenerator("recording");
    const failed = new FakeRecorder();
    const first = startTestRecording(device, timer, ids, () => failed);
    const joined = startTestRecording(device, timer, ids, () => {
      throw new Error("second recorder must not be constructed");
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
          "Failed to start test recording: adb startup failed",
        );
      }
    }
    expect(failed.stopCount).toBe(1);
    expect(getTestRecordingStatus(timer)).toBeNull();

    const next = new FakeRecorder();
    const retry = startTestRecording(otherDevice, timer, ids, () => next);
    next.startGate.resolve();
    expect((await retry).deviceId).toBe(otherDevice.deviceId);
    await expect(stopTestRecording(undefined, undefined, timer)).rejects.toThrow(
      "No recorded interactions",
    );
  });
});

describe("testRecordingManager stopping reservation", () => {
  test("successful stop releases the active recording and returns its result", async () => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    recorder.steps = [capturedStep];
    const { result: started } = await start(timer, recorder);

    const result = await stopTestRecording(started.recordingId, undefined, timer);

    expect(result.recordingId).toBe(started.recordingId);
    expect(result.stepCount).toBe(1);
    expect(getTestRecordingStatus(timer)).toBeNull();
    expect(recorder.stopCount).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("rejected stop releases the session and a new start constructs a new recorder", async () => {
    const timer = new FakeTimer();
    const ids = new CountingIdGenerator("recording");
    const failed = new FakeRecorder();
    failed.stopError = new Error("device disconnected");
    const { result: started } = await start(timer, failed, ids);

    const stopError = await stopTestRecording(started.recordingId, undefined, timer).catch(
      (error: unknown) => error,
    );
    expect(stopError).toBeInstanceOf(ActionableError);
    expect(stopError).toHaveProperty(
      "message",
      "Failed to stop test recording: device disconnected",
    );
    expect(getTestRecordingStatus(timer)).toBeNull();

    const replacement = new FakeRecorder();
    let factoryCalls = 0;
    const next = startTestRecording(device, timer, ids, () => {
      factoryCalls++;
      return replacement;
    });
    await Promise.resolve();
    replacement.startGate.resolve();
    const nextStarted = await next;
    expect(nextStarted.recordingId).not.toBe(started.recordingId);
    expect(factoryCalls).toBe(1);
    await expect(stopTestRecording(undefined, undefined, timer)).rejects.toThrow(
      "No recorded interactions",
    );
  });

  test("timed out stop releases the session and allows a fresh start", async () => {
    const timer = new FakeTimer();
    const ids = new CountingIdGenerator("recording");
    const hung = new FakeRecorder();
    hung.stopGate = new Deferred<{ steps: PlanStep[]; stepCount: number }>();
    const { result: started } = await start(timer, hung, ids);

    const stopping = stopTestRecording(started.recordingId, undefined, timer);
    await Promise.resolve();
    timer.advanceTime(10_000);
    const timeoutError = await stopping.catch((error: unknown) => error);
    expect(timeoutError).toBeInstanceOf(ActionableError);
    expect(timeoutError).toHaveProperty(
      "message",
      "Failed to stop test recording: Test recording stop timed out after 10000 ms",
    );
    expect(getTestRecordingStatus(timer)).toBeNull();

    const replacement = new FakeRecorder();
    const next = startTestRecording(device, timer, ids, () => replacement);
    await Promise.resolve();
    replacement.startGate.resolve();
    expect((await next).recordingId).not.toBe(started.recordingId);
    await expect(stopTestRecording(undefined, undefined, timer)).rejects.toThrow(
      "No recorded interactions",
    );
  });

  test("concurrent stops share the successful stop result", async () => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    recorder.steps = [capturedStep];
    recorder.stopGate = new Deferred<{ steps: PlanStep[]; stepCount: number }>();
    const { result: started } = await start(timer, recorder);

    const first = stopTestRecording(started.recordingId, undefined, timer);
    const second = stopTestRecording(started.recordingId, undefined, timer);
    await Promise.resolve();
    expect(recorder.stopCount).toBe(1);
    recorder.stopGate.resolve({ steps: [capturedStep], stepCount: 1 });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(getTestRecordingStatus(timer)).toBeNull();
  });

  test("concurrent stops share the same failure", async () => {
    const timer = new FakeTimer();
    const recorder = new FakeRecorder();
    recorder.stopGate = new Deferred<{ steps: PlanStep[]; stepCount: number }>();
    const { result: started } = await start(timer, recorder);

    const first = stopTestRecording(started.recordingId, undefined, timer);
    const second = stopTestRecording(started.recordingId, undefined, timer);
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
    expect(getTestRecordingStatus(timer)).toBeNull();
  });

  test("start during an in-flight stop waits, then creates a fresh recording", async () => {
    const timer = new FakeTimer();
    const ids = new CountingIdGenerator("recording");
    const firstRecorder = new FakeRecorder();
    firstRecorder.steps = [capturedStep];
    firstRecorder.stopGate = new Deferred<{ steps: PlanStep[]; stepCount: number }>();
    const { result: started } = await start(timer, firstRecorder, ids);

    const stopping = stopTestRecording(started.recordingId, undefined, timer);
    await Promise.resolve();
    expect(getTestRecordingStatus(timer)).toBeNull();
    const nextRecorder = new FakeRecorder();
    let factoryCalls = 0;
    const starting = startTestRecording(device, timer, ids, () => {
      factoryCalls++;
      return nextRecorder;
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
    await expect(stopTestRecording(undefined, undefined, timer)).rejects.toThrow(
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
  await startTestRecording(
    device,
    timer,
    new CountingIdGenerator("touch-health"),
    () => new DualTrackRecorder(device, gestures, a11y, timer),
  );
  return { timer, gestures, a11y };
}

describe("testRecordingManager touch-track health", () => {
  test("spawn failure with zero steps rejects with actionable getevent cause", async () => {
    const { timer, gestures } = await startDualTrack();
    gestures.onError?.(new Error("spawn adb ENOENT"));
    const outcome = await stopTestRecording(undefined, "failed-touch", timer).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(ActionableError);
    expect(outcome).toHaveProperty(
      "message",
      "Failed to stop test recording: Touch track (getevent) stopped 0 ms after recording start: spawn adb ENOENT. Later taps may be missing.",
    );
    expect(getTestRecordingStatus(timer)).toBeNull();
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
      const result = await stopTestRecording(undefined, "partial-touch", timer);
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
    const result = await stopTestRecording(undefined, "text-only", timer);
    expect(result.stepCount).toBe(1);
    expect(result.planContent).toContain("sendKeys");
    expect(result.planContent).toContain("hello");
    expect(result.error).toContain("getevent permission denied");
    expect(result.error).toContain("Later taps may be missing");
  });

  test("healthy stop has no warning even when the emitter reports its own shutdown", async () => {
    const { timer, gestures } = await startDualTrack();
    gestures.onGesture?.({ type: "tap", arrivedAt: timer.now(), screenX: 10, screenY: 20 });
    const result = await stopTestRecording(undefined, "healthy-touch", timer);
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
