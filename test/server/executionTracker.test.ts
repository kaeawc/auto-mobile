import { describe, expect, test } from "bun:test";
import { ExecutionTracker, type ExecutionScopeOptions } from "../../src/server/executionTracker";
import { DeviceLostError } from "../../src/server/deviceLossOutcome";
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
  test("records a typed device-loss reason for a device-disconnected cancel", async function() {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", undefined, "session-uuid");

    const cancelled = await tracker.cancelSessionUuidExecutions(
      "session-uuid",
      "device-disconnected:emulator-5554"
    );

    expect(cancelled).toBe(1);
    expect(execution.abortController.signal.aborted).toBe(true);
    expect(execution.cancelReason).toBeInstanceOf(DeviceLostError);
    expect(execution.cancelReason).toMatchObject({
      deviceId: "emulator-5554",
      message: "device-disconnected:emulator-5554",
    });
  });

  test("keeps transport cancellation reasons log-only", async function() {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", "session-id");

    await tracker.cancelSessionExecutions("session-id", "streamable_http_onclose");

    expect(execution.abortController.signal.reason).not.toEqual(new Error("streamable_http_onclose"));
    expect(execution.cancelReason).toBeUndefined();
  });

  // #4183 item 5 (A2): src-behavior assertion refiled from the old "cancel leaves session
  // active" test. Cancelling aborts the in-flight AbortController but must NOT remove the
  // execution from the tracker — only endExecution() tears down the session bookkeeping.
  // So the session remains "active" after a cancel, which is what lets a fresh execution
  // still observe an active session until it is explicitly ended.
  test("cancellation aborts but leaves the session's execution active", async function() {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", undefined, "session-uuid");

    const cancelled = await tracker.cancelSessionUuidExecutions(
      "session-uuid",
      "device-disconnected:emulator-5554"
    );

    expect(cancelled).toBe(1);
    expect(execution.abortController.signal.aborted).toBe(true);
    // The session is not torn down by cancellation.
    expect(tracker.hasActiveSessionUuidExecutions("session-uuid")).toBe(true);

    // Only endExecution() clears the session bookkeeping.
    tracker.endExecution(execution.id);
    expect(tracker.hasActiveSessionUuidExecutions("session-uuid")).toBe(false);
  });

  test("keeps the shutdown control operation alive while cancelling device work", async function() {
    const tracker = new ExecutionTracker(
      new FakeTimer(),
      new FakeIdGenerator(["kill", "tap"]),
    );
    const kill = tracker.startExecution("executePlan", undefined, "session-uuid");
    const tap = tracker.startExecution("tapOn", undefined, "session-uuid");

    const cancelled = await tracker.cancelSessionUuidExecutions(
      "session-uuid",
      "device-disconnected:emulator-5554",
      { excludeSignal: kill.abortController.signal },
    );

    expect(cancelled).toBe(1);
    expect(kill.abortController.signal.aborted).toBe(false);
    expect(tap.abortController.signal.aborted).toBe(true);
  });

  test("cancels a forwarded execution when its transport session closes", async function() {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution(
      "tapOn",
      "forwarded-mcp-session",
      undefined,
      "streamable-http-session",
    );

    expect(tracker.hasActiveSessionExecutions("forwarded-mcp-session")).toBe(true);
    expect(tracker.hasActiveSessionExecutions("streamable-http-session")).toBe(true);

    await tracker.cancelSessionExecutions("streamable-http-session", "streamable_http_onclose");

    expect(execution.abortController.signal.aborted).toBe(true);
  });

  test("distinguishes executions that began before a session deadline", function() {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["before", "after"]));
    tracker.startExecution("tapOn", "session-id");
    timer.advanceTime(10);

    expect(tracker.hasActiveSessionExecutions("session-id", { startedAtOrBefore: 5 })).toBe(true);

    tracker.endExecution("before");
    tracker.startExecution("tapOn", "session-id");

    expect(tracker.hasActiveSessionExecutions("session-id", { startedAtOrBefore: 5 })).toBe(false);
  });

  // #4183 item 6 (A3): the scope fallback in hasActiveToolExecution (executionTracker.ts)
  // had no table coverage. The scope order is: explicit "global" → sessionUuid map →
  // sessionId map → global fallback when neither key is provided.
  describe("hasActiveToolExecution scope fallback", function() {
    const makeTracker = function(): ExecutionTracker {
      const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
      tracker.startExecution("executePlan", "session-id", "session-uuid");
      return tracker;
    };

    test.each<[string, ExecutionScopeOptions, boolean]>([
      ["global scope matches regardless of present non-matching session keys", { scope: "global", sessionId: "other-id", sessionUuid: "other-uuid" }, true],
      ["session scope matches on sessionUuid", { scope: "session", sessionUuid: "session-uuid" }, true],
      ["session scope misses on non-matching sessionUuid", { scope: "session", sessionUuid: "other-uuid" }, false],
      ["session scope falls back to sessionId when no uuid", { scope: "session", sessionId: "session-id" }, true],
      ["session scope misses on non-matching sessionId", { scope: "session", sessionId: "other-id" }, false],
      ["session scope with neither key falls back to global", { scope: "session" }, true],
    ])("%s", function(_name, options, expected) {
      const tracker = makeTracker();
      expect(tracker.hasActiveToolExecution("executePlan", options)).toBe(expected);
    });

    test("global scope does not match a different tool name", function() {
      const tracker = makeTracker();
      expect(tracker.hasActiveToolExecution("tapOn", { scope: "global" })).toBe(false);
    });
  });
});
