import { describe, expect, test } from "bun:test";
import { throwIfAborted } from "../../src/utils/toolUtils";
import { OPERATION_CANCELLED_MESSAGE } from "../../src/utils/constants";
import { DeviceLostError } from "../../src/server/deviceLossOutcome";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

describe("throwIfAborted", () => {
  test("throws the cancellation error when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(OPERATION_CANCELLED_MESSAGE);
  });

  test("preserves the typed device-loss cancellation reason", () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554");
    controller.abort(deviceLoss);

    expect(() => throwIfAborted(controller.signal)).toThrow(deviceLoss);
  });

  test("preserves tracked device loss when AbortSignal.reason is unavailable", async () => {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("observe", undefined, "session-a");
    await tracker.cancelSessionUuidExecutions("session-a", "device-disconnected:emulator-5554");
    Object.defineProperty(execution.abortController.signal, "reason", {
      configurable: true,
      value: undefined,
    });

    let thrown: unknown;
    try {
      throwIfAborted(execution.abortController.signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeviceLostError);
  });

  test("does not throw when the signal is not aborted", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  test("does not throw when no signal is provided", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });
});
