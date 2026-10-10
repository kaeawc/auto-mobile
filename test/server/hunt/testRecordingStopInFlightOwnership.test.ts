import { describe, expect, test } from "bun:test";
import type { BootedDevice, PlanStep } from "../../../src/models";
import {
  isTestRecordingOwnedBy,
  startTestRecording,
  stopTestRecording,
} from "../../../src/server/testRecordingManager";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const step: PlanStep = { tool: "tapOn", params: { text: "OK" } };

describe("hunt: test recording ownership while its stop is in flight", () => {
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
