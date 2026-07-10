import { describe, expect, test } from "bun:test";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

describe("ExecutionTracker", function() {
  test("uses injected id generator and timer when starting executions", function() {
    const timer = new FakeTimer();
    timer.setCurrentTime(1234);
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["execution-1"]));

    const execution = tracker.startExecution("tapOn", "session-id", "session-uuid");

    expect(execution.id).toBe("execution-1");
    expect(execution.startTime).toBe(1234);
  });

  test("uses custom cancellation reason as abort signal reason", async function() {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", undefined, "session-uuid");

    const cancelled = await tracker.cancelSessionUuidExecutions(
      "session-uuid",
      "device-disconnected:emulator-5554"
    );

    expect(cancelled).toBe(1);
    expect(execution.abortController.signal.reason).toEqual(new Error("device-disconnected:emulator-5554"));
  });
});
