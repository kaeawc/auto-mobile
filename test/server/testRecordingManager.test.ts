import { describe, expect, test } from "bun:test";
import type { BootedDevice, PlanStep } from "../../src/models";
import {
  getTestRecordingStatus,
  startTestRecording,
  stopTestRecording,
} from "../../src/server/testRecordingManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
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

  get stepCount(): number {
    return 0;
  }

  async start(): Promise<void> {
    this.startCount++;
    await this.startGate.promise;
  }

  async stop(): Promise<{ steps: PlanStep[]; stepCount: number }> {
    this.stopCount++;
    return { steps: [], stepCount: 0 };
  }
}

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
