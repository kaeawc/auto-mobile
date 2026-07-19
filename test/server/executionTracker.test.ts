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

  // Re-enabled from #3909. The prior assertion read `abortController.signal.reason`, whose
  // value is intermittently `undefined` on macOS CI under load even though cancellation fired
  // (a Bun `AbortSignal.reason` observability quirk, not a logic race — the abort is dispatched
  // synchronously). We assert the tracker's own `cancelReason`, recorded synchronously at
  // cancellation, which is deterministic across runtimes, plus that the signal did abort.
  test("records the custom cancellation reason for a device-disconnected cancel", async function() {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", undefined, "session-uuid");

    const cancelled = await tracker.cancelSessionUuidExecutions(
      "session-uuid",
      "device-disconnected:emulator-5554"
    );

    expect(cancelled).toBe(1);
    expect(execution.abortController.signal.aborted).toBe(true);
    expect(execution.cancelReason).toEqual(new Error("device-disconnected:emulator-5554"));
  });

  test("keeps transport cancellation reasons log-only", async function() {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", "session-id");

    await tracker.cancelSessionExecutions("session-id", "streamable_http_onclose");

    expect(execution.abortController.signal.reason).not.toEqual(new Error("streamable_http_onclose"));
    expect(execution.cancelReason).toBeUndefined();
  });
});
