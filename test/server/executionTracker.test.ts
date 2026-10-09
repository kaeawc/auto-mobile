import { describe, expect, test } from "bun:test";
import { ExecutionTracker, type ExecutionScopeOptions } from "../../src/server/executionTracker";
import { DeviceLostError } from "../../src/server/deviceLossOutcome";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { DaemonHandoffInterruptionError } from "../../src/daemon/daemonHandoffInterruption";

describe("ExecutionTracker", function () {
  test("an acquisition cancels only the sessionless device use recorded on that device (#10829)", () => {
    const tracker = new ExecutionTracker(
      new FakeTimer(),
      new FakeIdGenerator(["a", "b", "c", "d"]),
    );
    const onDevice = tracker.startExecution("rotate");
    const otherDevice = tracker.startExecution("rotate");
    const watching = tracker.startExecution("observe");
    const acquiring = tracker.startExecution("executePlan");
    tracker.markSessionlessDeviceUse(onDevice.id, "emulator-5554");
    tracker.markSessionlessDeviceUse(otherDevice.id, "emulator-5556");
    tracker.bindDeviceExecution(watching.id, "emulator-5554");
    tracker.markSessionlessDeviceUse(acquiring.id, "emulator-5554");

    const cancelled = tracker.cancelSessionlessDeviceUse("emulator-5554", {
      excludeExecutionId: acquiring.id,
    });

    expect(cancelled).toBe(1);
    expect(onDevice.abortController.signal.reason).toMatchObject({
      code: "device_owned_by_other_session",
      deviceId: "emulator-5554",
    });
    expect((onDevice.abortController.signal.reason as Error).message).toStartWith(
      "rotate refused: device 'emulator-5554' is held by another session.",
    );
    expect(otherDevice.abortController.signal.aborted).toBe(false);
    expect(watching.abortController.signal.aborted).toBe(false);
    expect(acquiring.abortController.signal.aborted).toBe(false);
    expect(tracker.cancelSessionlessDeviceUse("emulator-5554")).toBe(1);
    expect(tracker.cancelSessionlessDeviceUse("emulator-5554")).toBe(0);
  });

  test("tracks per-device activity for forwarding-lease idleness (#10497)", () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["a", "b"]));
    expect(tracker.getDeviceIdleForMs("emulator-5554")).toBeNull();
    const a = tracker.startExecution("tapOn");
    const b = tracker.startExecution("observe");
    tracker.bindDeviceExecution(a.id, "emulator-5554");
    tracker.bindDeviceExecution(b.id, "emulator-5554");
    expect(tracker.getActiveDeviceExecutionCount("emulator-5554")).toBe(2);
    timer.setCurrentTime(4_000);
    tracker.endExecution(a.id);
    tracker.endExecution(b.id);
    expect(tracker.getActiveDeviceExecutionCount("emulator-5554")).toBe(0);
    timer.setCurrentTime(9_000);
    expect(tracker.getDeviceIdleForMs("emulator-5554")).toBe(5_000);
  });

  test("cancels sessionless device work once, excluding discovery and other devices", async () => {
    const tracker = new ExecutionTracker(
      new FakeTimer(),
      new FakeIdGenerator(["work", "discover", "other"]),
    );
    const work = tracker.startExecution("takeScreenshot");
    const discover = tracker.startExecution("killDevice");
    const other = tracker.startExecution("takeScreenshot");
    tracker.bindDeviceExecution(work.id, "emulator-5554");
    tracker.bindDeviceExecution(work.id, "emulator-5554");
    tracker.bindDeviceExecution(discover.id, "emulator-5554");
    tracker.bindDeviceExecution(other.id, "emulator-5556");
    expect(
      await tracker.cancelDeviceExecutions("emulator-5554", "device-disconnected:emulator-5554", {
        excludeExecutionId: discover.id,
      }),
    ).toBe(1);
    expect(work.abortController.signal.aborted).toBe(true);
    expect(work.cancelReason).toBeInstanceOf(DeviceLostError);
    expect(discover.abortController.signal.aborted).toBe(false);
    expect(other.abortController.signal.aborted).toBe(false);
  });

  test("onlySessionUuid cancels and drains just the session's work on a shared device (#9944)", async () => {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(
      timer,
      new FakeIdGenerator(["owned", "autolock", "provisional", "peer", "sessionless", "caller"]),
    );
    const owned = tracker.startExecution("observe", undefined, "session-1");
    const autolock = tracker.startExecution("tapOn");
    tracker.setResolvedAutolockSessionUuid(autolock.id, "session-1");
    const provisional = tracker.startExecution("swipeOn");
    const peer = tracker.startExecution("observe", undefined, "session-2");
    const sessionless = tracker.startExecution("observe");
    const caller = tracker.startExecution("setActiveDevice", undefined, "session-1");
    for (const execution of [owned, autolock, provisional, peer, sessionless, caller]) {
      tracker.bindDeviceExecution(execution.id, "emulator-5554");
    }
    tracker.endExecution(provisional.id);

    const reason = new Error("rebound");
    const filter = { excludeExecutionId: caller.id, onlySessionUuid: "session-1" };
    expect(await tracker.cancelDeviceExecutions("emulator-5554", reason, filter)).toBe(2);

    expect(owned.abortController.signal.reason).toBe(reason);
    expect(autolock.abortController.signal.aborted).toBe(true);
    expect(peer.abortController.signal.aborted).toBe(false);
    expect(sessionless.abortController.signal.aborted).toBe(false);
    expect(caller.abortController.signal.aborted).toBe(false);

    // Peer and sessionless work stay running and must not hold up the drain.
    const drain = tracker.waitForDeviceExecutionsToEnd("emulator-5554", 100, filter);
    tracker.endExecution(owned.id);
    tracker.endExecution(autolock.id);
    expect(await drain).toBe(true);
    expect(tracker.hasActiveDeviceExecutions("emulator-5554")).toBe(true);
  });

  describe("a session-scoped device cancel refuses later binds to that device (#9958)", () => {
    const rebound = new ActionableError(
      "Session session-1 was rebound from device 'emulator-5554'",
    );
    const filter = { excludeExecutionId: "caller", onlySessionUuid: "session-1" };

    test("an execution admitted but not yet bound cannot bind afterwards", async () => {
      const tracker = new ExecutionTracker(
        new FakeTimer(),
        new FakeIdGenerator(["pending", "autolock", "caller"]),
      );
      const pending = tracker.startExecution("tapOn", undefined, "session-1");
      const autolock = tracker.startExecution("tapOn");
      tracker.setResolvedAutolockSessionUuid(autolock.id, "session-1");
      const caller = tracker.startExecution("setActiveDevice", undefined, "session-1");

      expect(await tracker.cancelDeviceExecutions("emulator-5554", rebound, filter)).toBe(0);

      for (const execution of [pending, autolock]) {
        expect(() => tracker.bindDeviceExecution(execution.id, "emulator-5554")).toThrow(
          /Session session-1 was rebound from device 'emulator-5554'/,
        );
        expect(tracker.hasActiveDeviceExecutions("emulator-5554")).toBe(false);
      }
      // The rebind's own caller keeps the right to bind, and so does any other device.
      tracker.bindDeviceExecution(caller.id, "emulator-5554");
      tracker.bindDeviceExecution(pending.id, "emulator-5556");
      expect(tracker.hasActiveDeviceExecutions("emulator-5556")).toBe(true);
    });

    test("an execution already cancelled by the rebind cannot re-bind to the old device", async () => {
      const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["running"]));
      const running = tracker.startExecution("observe", undefined, "session-1");
      tracker.bindDeviceExecution(running.id, "emulator-5554");

      expect(await tracker.cancelDeviceExecutions("emulator-5554", rebound, filter)).toBe(1);

      expect(() => tracker.bindDeviceExecution(running.id, "emulator-5554")).toThrow(
        ActionableError,
      );
    });

    test("peer, sessionless and later-admitted work still binds", async () => {
      const tracker = new ExecutionTracker(
        new FakeTimer(),
        new FakeIdGenerator(["peer", "sessionless", "later"]),
      );
      const peer = tracker.startExecution("observe", undefined, "session-2");
      const sessionless = tracker.startExecution("observe");

      await tracker.cancelDeviceExecutions("emulator-5554", rebound, filter);
      const later = tracker.startExecution("observe", undefined, "session-1");

      for (const execution of [peer, sessionless, later]) {
        tracker.bindDeviceExecution(execution.id, "emulator-5554");
      }
      expect(tracker.hasActiveDeviceExecutions("emulator-5554")).toBe(true);
    });

    test("kill, ANR and device-loss cancels (no session filter) never refuse a bind", async () => {
      const tracker = new ExecutionTracker(
        new FakeTimer(),
        new FakeIdGenerator(["owned", "sessionless"]),
      );
      const owned = tracker.startExecution("observe", undefined, "session-1");
      const sessionless = tracker.startExecution("observe");
      tracker.bindDeviceExecution(owned.id, "emulator-5554");

      await tracker.cancelDeviceExecutions("emulator-5554", "device-disconnected:emulator-5554");
      await tracker.cancelDeviceExecutions("emulator-5554", new Error("System UI ANR"));

      expect(owned.abortController.signal.aborted).toBe(true);
      tracker.bindDeviceExecution(owned.id, "emulator-5554");
      tracker.bindDeviceExecution(sessionless.id, "emulator-5554");
    });

    test("a bind after the execution ended stays a no-op", async () => {
      const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["gone"]));
      const gone = tracker.startExecution("observe", undefined, "session-1");
      await tracker.cancelDeviceExecutions("emulator-5554", rebound, filter);
      tracker.endExecution(gone.id);

      tracker.bindDeviceExecution(gone.id, "emulator-5554");
      expect(tracker.hasActiveDeviceExecutions("emulator-5554")).toBe(false);
    });
  });

  test("endExecution removes every device binding and allows drain to finish", async () => {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["work"]));
    const work = tracker.startExecution("takeScreenshot");
    tracker.bindDeviceExecution(work.id, "emulator-5554");
    tracker.bindDeviceExecution(work.id, "emulator-5556");
    const drain = tracker.waitForDeviceExecutionsToEnd("emulator-5554", 100);
    tracker.endExecution(work.id);
    expect(await drain).toBe(true);
    expect(tracker.hasActiveDeviceExecutions("emulator-5554")).toBe(false);
    expect(tracker.hasActiveDeviceExecutions("emulator-5556")).toBe(false);
    expect(tracker["deviceExecutions"].size).toBe(0);
    tracker.bindDeviceExecution(work.id, "emulator-5554");
    expect(await tracker.cancelDeviceExecutions("emulator-5554")).toBe(0);
  });

  test("device drain excludes discovery and has a FakeTimer timeout for undrained work", async () => {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["discover", "work"]));
    const discover = tracker.startExecution("killDevice");
    tracker.bindDeviceExecution(discover.id, "emulator-5554");
    expect(
      await tracker.waitForDeviceExecutionsToEnd("emulator-5554", 100, {
        excludeExecutionId: discover.id,
      }),
    ).toBe(true);
    const work = tracker.startExecution("takeScreenshot");
    tracker.bindDeviceExecution(work.id, "emulator-5554");
    const drain = tracker.waitForDeviceExecutionsToEnd("emulator-5554", 100, {
      excludeExecutionId: discover.id,
    });
    timer.advanceTime(100);
    expect(await drain).toBe(false);
    tracker.endExecution(work.id);
    expect(
      await tracker.waitForDeviceExecutionsToEnd("emulator-5554", 100, {
        excludeExecutionId: discover.id,
      }),
    ).toBe(true);
  });

  test("uses injected id generator and timer when starting executions", function () {
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
  test("records a typed device-loss reason for a device-disconnected cancel", async function () {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", undefined, "session-uuid");

    const cancelled = await tracker.cancelSessionUuidExecutions(
      "session-uuid",
      "device-disconnected:emulator-5554",
    );

    expect(cancelled).toBe(1);
    expect(execution.abortController.signal.aborted).toBe(true);
    expect(execution.cancelReason).toBeInstanceOf(DeviceLostError);
    expect(execution.cancelReason).toMatchObject({
      deviceId: "emulator-5554",
      message: "device-disconnected:emulator-5554",
    });
  });

  test("keeps transport cancellation reasons log-only", async function () {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", "session-id");

    await tracker.cancelSessionExecutions("session-id", "streamable_http_onclose");

    expect(execution.abortController.signal.reason).not.toEqual(
      new Error("streamable_http_onclose"),
    );
    expect(execution.cancelReason).toBeUndefined();
  });

  test("preserves a typed daemon handoff cancellation reason", async function () {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("provisionDevice", "session-id");
    const reason = new DaemonHandoffInterruptionError("daemon shutdown interrupted provisioning");

    await tracker.cancelSessionExecutions("session-id", reason);

    expect(execution.abortController.signal.reason).toBe(reason);
    expect(execution.cancelReason).toBe(reason);
  });

  test("atomically elects one restart owner and fences active device operations", function () {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(
      timer,
      new FakeIdGenerator(["active-provision", "after-clear"]),
    );
    const active = tracker.startExecution("tapOn", "active-session");

    expect(tracker.prepareForDaemonRestart()).toBe("active_operations");
    tracker.endExecution(active.id);
    expect(tracker.prepareForDaemonRestart()).toBe("accepted");
    expect(tracker.prepareForDaemonRestart()).toBe("restart_pending");
    expect(() => tracker.startExecution("provisionDevice", "blocked-session")).toThrow(
      "Daemon restart is pending",
    );
    expect(() => tracker.startExecution("tapOn", "blocked-device-session")).toThrow(
      "Daemon restart is pending",
    );

    timer.advanceTime(5_000);
    expect(() => tracker.startExecution("provisionDevice", "still-blocked")).toThrow(
      "Daemon restart is pending",
    );
    tracker.clearDaemonRestartPreparation();
    expect(tracker.startExecution("provisionDevice", "after-clear").id).toBe("after-clear");
  });

  test("restart admission observes active provisioning through the injected query", function () {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator([]));
    let active = true;
    tracker.setActiveProvisionDeviceQuery({ hasActiveProvisionDeviceOperation: () => active });

    expect(tracker.prepareForDaemonRestart()).toBe("active_operations");
    active = false;
    expect(tracker.prepareForDaemonRestart()).toBe("accepted");
  });

  test("rejects active sessions before atomically fencing explicit maintenance work", function () {
    const tracker = new ExecutionTracker(
      new FakeTimer(),
      new FakeIdGenerator(["blocked", "after-maintenance"]),
    );

    expect(tracker.prepareForDaemonMaintenance(1)).toBe("active_sessions");
    expect(tracker.prepareForDaemonMaintenance(0)).toBe("accepted");
    expect(tracker.prepareForDaemonMaintenance(0)).toBe("maintenance_pending");
    expect(() => tracker.startExecution("startDevice", "blocked")).toThrow(
      "Daemon restart is pending",
    );

    tracker.clearDaemonMaintenancePreparation();
    expect(tracker.startExecution("startDevice", "after-maintenance").id).toBe("blocked");
  });

  test("keeps ordinary restart admission behind an authorized maintenance fence", function () {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator([]));

    expect(tracker.prepareForDaemonMaintenance(0)).toBe("accepted");
    expect(tracker.prepareForDaemonRestart()).toBe("restart_pending");
    expect(tracker.prepareForAdmittedDaemonRestart()).toBe("accepted");
    expect(tracker.prepareForAdmittedDaemonRestart()).toBe("restart_pending");
  });

  test("cancels and drains active provisioning before daemon shutdown continues", async function () {
    const tracker = new ExecutionTracker(
      new FakeTimer(),
      new FakeIdGenerator(["provision", "other"]),
    );
    const provision = tracker.startExecution("provisionDevice", "provision-session");
    const other = tracker.startExecution("tapOn", "other-session");
    const reason = new DaemonHandoffInterruptionError("daemon handoff");

    expect(await tracker.cancelToolExecutions("provisionDevice", reason)).toBe(1);
    expect(provision.abortController.signal.reason).toBe(reason);
    expect(other.abortController.signal.aborted).toBe(false);

    const drained = tracker.waitForToolExecutionsToEnd("provisionDevice", 1_000);
    tracker.endExecution(provision.id);
    expect(await drained).toBe(true);
  });

  // #4183 item 5 (A2): src-behavior assertion refiled from the old "cancel leaves session
  // active" test. Cancelling aborts the in-flight AbortController but must NOT remove the
  // execution from the tracker — only endExecution() tears down the session bookkeeping.
  // So the session remains "active" after a cancel, which is what lets a fresh execution
  // still observe an active session until it is explicitly ended.
  test("cancellation aborts but leaves the session's execution active", async function () {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", undefined, "session-uuid");

    const cancelled = await tracker.cancelSessionUuidExecutions(
      "session-uuid",
      "device-disconnected:emulator-5554",
    );

    expect(cancelled).toBe(1);
    expect(execution.abortController.signal.aborted).toBe(true);
    // The session is not torn down by cancellation.
    expect(tracker.hasActiveSessionUuidExecutions("session-uuid")).toBe(true);

    // Only endExecution() clears the session bookkeeping.
    tracker.endExecution(execution.id);
    expect(tracker.hasActiveSessionUuidExecutions("session-uuid")).toBe(false);
  });

  test("keeps the shutdown control operation alive while cancelling device work", async function () {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["kill", "tap"]));
    const kill = tracker.startExecution("executePlan", undefined, "session-uuid");
    const tap = tracker.startExecution("tapOn", undefined, "session-uuid");

    const cancelled = await tracker.cancelSessionUuidExecutions(
      "session-uuid",
      "device-disconnected:emulator-5554",
      { excludeExecutionId: kill.id },
    );

    expect(cancelled).toBe(1);
    expect(kill.abortController.signal.aborted).toBe(false);
    expect(tap.abortController.signal.aborted).toBe(true);
  });

  test("cancels a forwarded execution when its transport session closes", async function () {
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

  test("distinguishes executions that began before a session deadline", function () {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["before", "after"]));
    tracker.startExecution("tapOn", "session-id");
    timer.advanceTime(10);

    expect(tracker.hasActiveSessionExecutions("session-id", { startedAtOrBefore: 5 })).toBe(true);

    tracker.endExecution("before");
    tracker.startExecution("tapOn", "session-id");

    expect(tracker.hasActiveSessionExecutions("session-id", { startedAtOrBefore: 5 })).toBe(false);
  });

  test("tracks an implicit execution under its resolved autolock session", function () {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", "mcp-session");

    tracker.setResolvedAutolockSessionUuid(execution.id, "autolock-session");

    expect(tracker.hasActiveAutolockSessionExecutions("autolock-session")).toBe(true);
    expect(tracker.hasActiveAutolockSessionExecutions("replacement-session")).toBe(false);

    tracker.endExecution(execution.id);

    expect(tracker.hasActiveAutolockSessionExecutions("autolock-session")).toBe(false);
  });

  test("cancels and drains an implicit call before its target resolves", async function () {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["implicit"]));
    const autolockSessions = new Map([["mcp-session", "device-session"]]);
    tracker.setAutolockSessionResolver({
      autolockSessionForMcpSession: (mcpSessionId) => autolockSessions.get(mcpSessionId),
    });
    const execution = tracker.startExecution(
      "tapOn",
      "mcp-session",
      undefined,
      undefined,
      "mcp-session",
    );

    expect(tracker.hasActiveAutolockSessionExecutions("device-session")).toBe(true);
    autolockSessions.set("mcp-session", "replacement-session");
    expect(tracker.hasActiveAutolockSessionExecutions("device-session")).toBe(true);
    expect(tracker.hasActiveAutolockSessionExecutions("replacement-session")).toBe(false);
    expect(
      await tracker.cancelDeviceSessionExecutions(
        "device-session",
        "device-disconnected:emulator-5554",
      ),
    ).toBe(1);
    expect(execution.abortController.signal.aborted).toBe(true);
    expect(execution.cancelReason).toBeInstanceOf(DeviceLostError);

    const drained = tracker.waitForDeviceSessionExecutionsToEnd("device-session", 1_000);
    tracker.setResolvedAutolockSessionUuid(execution.id, "device-session");
    tracker.setResolvedAutolockSessionUuid(execution.id, "device-session");
    expect(tracker.hasActiveAutolockSessionExecutions("device-session")).toBe(true);
    expect(tracker.hasActiveAutolockSessionExecutions("replacement-session")).toBe(false);

    tracker.endExecution(execution.id);
    await expect(drained).resolves.toBe(true);
    expect(tracker.getActiveExecutionCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("releases the pinned session when routing selects another session or none", async function () {
    const tracker = new ExecutionTracker(
      new FakeTimer(),
      new FakeIdGenerator(["different", "none"]),
    );
    tracker.setAutolockSessionResolver({ autolockSessionForMcpSession: () => "session-a" });
    const different = tracker.startExecution("tapOn", "mcp", undefined, undefined, "mcp");
    const none = tracker.startExecution("swipeOn", "mcp", undefined, undefined, "mcp");
    const drainedA = tracker.waitForDeviceSessionExecutionsToEnd("session-a", 1_000);

    tracker.setResolvedAutolockSessionUuid(different.id, "session-b");
    tracker.setResolvedAutolockSessionUuid(none.id, undefined);

    expect(tracker.hasActiveAutolockSessionExecutions("session-a")).toBe(false);
    expect(tracker.hasActiveAutolockSessionExecutions("session-b")).toBe(true);
    expect(await tracker.cancelDeviceSessionExecutions("session-a")).toBe(0);
    expect(different.abortController.signal.aborted).toBe(false);
    expect(none.abortController.signal.aborted).toBe(false);
    await expect(drainedA).resolves.toBe(true);
    await expect(tracker.waitForDeviceSessionExecutionsToEnd("session-a", 1_000)).resolves.toBe(
      true,
    );
  });

  test("an unresolved implicit call blocks drain and expiry until it ends", async function () {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["implicit"]));
    tracker.setAutolockSessionResolver({
      autolockSessionForMcpSession: (mcpSessionId) =>
        mcpSessionId === "mcp-session" ? "device-session" : undefined,
    });
    const execution = tracker.startExecution(
      "tapOn",
      "mcp-session",
      undefined,
      undefined,
      "mcp-session",
    );
    const drained = tracker.waitForDeviceSessionExecutionsToEnd("device-session", 1_000);

    expect(tracker.hasActiveAutolockSessionExecutions("device-session")).toBe(true);
    await timer.advanceTimeAsync(1_000);
    await expect(drained).resolves.toBe(false);

    tracker.endExecution(execution.id);
    expect(tracker.hasActiveAutolockSessionExecutions("device-session")).toBe(false);
    expect(tracker.getActiveExecutionCount()).toBe(0);
  });

  test("cancels explicit and implicit work for one device session", async function () {
    const tracker = new ExecutionTracker(
      new FakeTimer(),
      new FakeIdGenerator(["explicit", "implicit"]),
    );
    const explicit = tracker.startExecution("tapOn", "mcp-explicit", "device-session");
    const implicit = tracker.startExecution("tapOn", "mcp-implicit");
    tracker.setResolvedAutolockSessionUuid(implicit.id, "device-session");

    const cancelled = await tracker.cancelDeviceSessionExecutions(
      "device-session",
      "device-disconnected:process-wide-adb-reset",
    );

    expect(cancelled).toBe(2);
    expect(explicit.abortController.signal.aborted).toBe(true);
    expect(implicit.abortController.signal.aborted).toBe(true);
  });

  test("waits for cancelled explicit and implicit device work to end", async function () {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["explicit", "implicit"]));
    const explicit = tracker.startExecution("tapOn", "mcp-explicit", "device-session");
    const implicit = tracker.startExecution("swipeOn", "mcp-implicit");
    tracker.setResolvedAutolockSessionUuid(implicit.id, "device-session");

    await tracker.cancelDeviceSessionExecutions(
      "device-session",
      "device-disconnected:process-wide-adb-reset",
    );
    const drained = tracker.waitForDeviceSessionExecutionsToEnd("device-session", 1_000);
    tracker.endExecution(explicit.id);
    await Promise.resolve();
    tracker.endExecution(implicit.id);

    await expect(drained).resolves.toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  // An execution that was deliberately exempted from the cancellation is not
  // going to end, so the drain must not wait on it: doing so spends the whole
  // budget and reports a false timeout for work that was never cancelled
  // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
  test("does not wait on an execution the cancellation exempted", async function () {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["kill", "tap"]));
    const kill = tracker.startExecution("killDevice", undefined, "device-session");
    const tap = tracker.startExecution("tapOn", undefined, "device-session");

    await tracker.cancelDeviceSessionExecutions(
      "device-session",
      "device-disconnected:emulator-5554",
      { excludeExecutionId: kill.id },
    );
    const drained = tracker.waitForDeviceSessionExecutionsToEnd("device-session", 1_000, {
      excludeExecutionId: kill.id,
    });
    tracker.endExecution(tap.id);

    await expect(drained).resolves.toBe(true);
    expect(kill.abortController.signal.aborted).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    tracker.endExecution(kill.id);
  });

  test("bounds the wait for signal-ignorant device work", async function () {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["execution-1"]));
    const execution = tracker.startExecution("tapOn", undefined, "device-session");

    const drained = tracker.waitForDeviceSessionExecutionsToEnd("device-session", 1_000);
    await timer.advanceTimeAsync(1_000);

    await expect(drained).resolves.toBe(false);
    tracker.endExecution(execution.id);
  });

  // #4183 item 6 (A3): the scope fallback in hasActiveToolExecution (executionTracker.ts)
  // had no table coverage. The scope order is: explicit "global" → sessionUuid map →
  // sessionId map → global fallback when neither key is provided.
  describe("hasActiveToolExecution scope fallback", function () {
    const makeTracker = function (): ExecutionTracker {
      const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["execution-1"]));
      tracker.startExecution("executePlan", "session-id", "session-uuid");
      return tracker;
    };

    test.each<[string, ExecutionScopeOptions, boolean]>([
      [
        "global scope matches regardless of present non-matching session keys",
        { scope: "global", sessionId: "other-id", sessionUuid: "other-uuid" },
        true,
      ],
      [
        "session scope matches on sessionUuid",
        { scope: "session", sessionUuid: "session-uuid" },
        true,
      ],
      [
        "session scope misses on non-matching sessionUuid",
        { scope: "session", sessionUuid: "other-uuid" },
        false,
      ],
      [
        "session scope falls back to sessionId when no uuid",
        { scope: "session", sessionId: "session-id" },
        true,
      ],
      [
        "session scope misses on non-matching sessionId",
        { scope: "session", sessionId: "other-id" },
        false,
      ],
      ["session scope with neither key falls back to global", { scope: "session" }, true],
    ])("%s", function (_name, options, expected) {
      const tracker = makeTracker();
      expect(tracker.hasActiveToolExecution("executePlan", options)).toBe(expected);
    });

    test("global scope does not match a different tool name", function () {
      const tracker = makeTracker();
      expect(tracker.hasActiveToolExecution("tapOn", { scope: "global" })).toBe(false);
    });
  });
});

describe("ExecutionTracker session execution deadlines (#10712)", () => {
  test("reports the latest deadline among a session's executions, or infinity when one has none", () => {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["a", "b", "c"]));
    expect(tracker.getLatestSessionExecutionDeadlineMs("s")).toBeUndefined();

    const first = tracker.startExecution("tapOn", undefined, "s");
    expect(tracker.getLatestSessionExecutionDeadlineMs("s")).toBe(Number.POSITIVE_INFINITY);
    tracker.setExecutionDeadline(first.id, () => 5_000);
    expect(tracker.getLatestSessionExecutionDeadlineMs("s")).toBe(5_000);

    const second = tracker.startExecution("observe", undefined, "s");
    let live = 9_000;
    tracker.setExecutionDeadline(second.id, () => live);
    expect(tracker.getLatestSessionExecutionDeadlineMs("s")).toBe(9_000);
    live = 12_000;
    expect(tracker.getLatestSessionExecutionDeadlineMs("s")).toBe(12_000);

    tracker.endExecution(second.id);
    expect(tracker.getLatestSessionExecutionDeadlineMs("s")).toBe(5_000);
    tracker.endExecution(first.id);
    expect(tracker.getLatestSessionExecutionDeadlineMs("s")).toBeUndefined();
  });

  test("counts resolved-autolock executions", () => {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["a"]));
    const execution = tracker.startExecution("tapOn", "mcp-session");
    tracker.setResolvedAutolockSessionUuid(execution.id, "autolock");
    tracker.setExecutionDeadline(execution.id, () => 7_000);
    expect(tracker.getLatestSessionExecutionDeadlineMs("autolock")).toBe(7_000);
  });
});
